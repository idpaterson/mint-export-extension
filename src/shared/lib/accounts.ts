import { DateTime, Interval } from 'luxon';

import { makeMintApiRequest } from '@root/src/shared/lib/auth';
import {
  DATE_FILTER_ALL_TIME,
  MINT_DAILY_TRENDS_MAX_DAYS,
  MINT_HEADERS,
} from '@root/src/shared/lib/constants';
import { formatCSV } from '@root/src/shared/lib/csv';
import { withRetry } from '@root/src/shared/lib/retry';
import {
  resolveSequential,
  withDefaultOnError,
  withRateLimit,
} from '@root/src/shared/lib/promises';

export type AccountCategory = 'DEBT' | 'ASSET';

export type TrendType = 'DEBT' | 'ASSET' | 'INCOME' | 'EXPENSE';

export type ReportType =
  | 'ASSETS_TIME'
  | 'DEBTS_TIME'
  | 'SPENDING_TIME'
  | 'INCOME_TIME'
  | 'NET_INCOME'
  | 'NET_WORTH';

export type FixedDateFilter =
  | 'LAST_7_DAYS'
  | 'LAST_14_DAYS'
  | 'THIS_MONTH'
  | 'LAST_MONTH'
  | 'LAST_3_MONTHS'
  | 'LAST_6_MONTHS'
  | 'LAST_12_MONTHS'
  | 'THIS_YEAR'
  | 'LAST_YEAR'
  | 'ALL_TIME'
  | 'CUSTOM';

type TrendEntry = {
  amount: number;
  date: string;
  // this is determined by the type of report we fetch (DEBTS_TIME/ASSETS_TIME)
  // it will return different values if we decide to fetch more types of reports (e.g., SPENDING_TIME)
  type: TrendType;
  /** Represents the negative amount in net income/worth trends. Calculated, not from Mint */
  inverseAmount?: number;
};

type TrendsResponse = {
  Trend: TrendEntry[];
  // there's more here...
};

/** State of user selections on the Mint Trends page */
export type TrendState = {
  /** Use with {@link deselectedAccountIds } to figure out which accounts to include in the trend */
  reportType: ReportType;
  /** All accounts eligible for the {@link reportType} that are NOT selected */
  deselectedAccountIds?: string[];
  /** Semantic representation of the {@link fromDate} {@link toDate} range */
  fixedFilter: FixedDateFilter;
  /** ISO start date */
  fromDate: string;
  /** ISO enddate */
  toDate: string;
};

export type BalanceHistoryProgressCallback = (progress: {
  completedAccounts: number;
  totalAccounts: number;
  completePercentage: number;
}) => void | Promise<void>;

export type BalanceHistoryCallbackProgress = Parameters<BalanceHistoryProgressCallback>[0];

export type TrendBalanceHistoryProgressCallback = (progress: {
  completePercentage: number;
}) => void | Promise<void>;

export type TrendBalanceHistoryCallbackProgress =
  Parameters<TrendBalanceHistoryProgressCallback>[0];

type ProgressCallback = (progress: { complete: number; total: number }) => void | Promise<void>;

type AccountIdFilter = {
  type: 'AccountIdFilter';
  accountId: string;
};

export type AccountType =
  | 'BankAccount'
  | 'CashAccount'
  | 'CreditAccount'
  | 'InsuranceAccount'
  | 'InvestmentAccount'
  | 'LoanAccount'
  | 'RealEstateAccount'
  | 'VehicleAccount'
  | 'OtherPropertyAccount';

type AccountTypeFilter = (accountType: AccountType) => boolean;

type AccountsResponse = {
  Account: {
    type: AccountType;
    id: string;
    name: string;
  }[];
};

type FetchAccountsOptions = {
  offset?: number;
  limit?: number;
  overrideApiKey?: string;
};

/**
 * Allows filtering accounts since the API does not seem to allow negated account ID queries, yet
 * also does not expose the selected accounts (see {@link deselectedAccountIds}).
 *
 * Logic from `accountsToFilter` data in Mint trends ui module.
 */
export const getAccountTypeFilterForTrend = (trend: TrendState): AccountTypeFilter => {
  const defaultFilter = (type) => type !== 'CashAccount' && type !== 'InsuranceAccount';
  switch (trend.reportType) {
    case 'INCOME_TIME':
    case 'SPENDING_TIME':
      return (type) =>
        type !== 'RealEstateAccount' && type !== 'VehicleAccount' && defaultFilter(type);
    case 'ASSETS_TIME':
      return (type) => type !== 'LoanAccount' && type !== 'CreditAccount' && defaultFilter(type);
    case 'DEBTS_TIME':
      return (type) =>
        type !== 'BankAccount' && type !== 'InvestmentAccount' && defaultFilter(type);
    case 'NET_INCOME':
      return (type) =>
        type !== 'RealEstateAccount' && type !== 'VehicleAccount' && defaultFilter(type);
    case 'NET_WORTH':
      return defaultFilter;
    default:
      throw new Error(`Unsupported report type: ${trend.reportType}`);
  }
};

/**
 * Use internal Mint "Trends" API to fetch account balance by month
 * for all time.
 *
 * This is technically a paginated API, but since the limit is 1000 (> 83 years)
 * we probably don't need to worry about pagination.
 */
export const fetchMonthlyBalancesForAccount = async ({
  accountId,
  offset,
  limit,
  overrideApiKey,
}: {
  accountId: string;
  offset?: number;
  limit?: number;
  overrideApiKey?: string;
}): Promise<{ balancesByDate: TrendEntry[]; reportType: string } | undefined> => {
  // we don't have a good way to know if an account is "asset" or "debt", so we just try both reports
  // the Mint API returns undefined if the report type doesn't match the account type
  const tryReportTypes = ['ASSETS_TIME', 'DEBTS_TIME'];

  for (const reportType of tryReportTypes) {
    const response = await fetchTrends({
      reportType,
      filters: [makeAccountIdFilter(accountId)],
      offset,
      limit,
      overrideApiKey,
    });
    const { Trend: balancesByDate } = await response.json();

    if (balancesByDate) {
      return { balancesByDate, reportType };
    }
  }
};

export const calculateIntervalForAccountHistory = (monthlyBalances: TrendEntry[]) => {
  const startDate = monthlyBalances[0]?.date;

  if (!startDate) {
    throw new Error('Unable to determine start date for account history.');
  }

  // find the last month with a non-zero balance
  let endDate: string;
  let monthIndex = monthlyBalances.length - 1;
  while (monthIndex > 0 && monthlyBalances[monthIndex].amount === 0) {
    monthIndex -= 1;
    endDate = monthlyBalances[monthIndex].date;
  }

  const now = DateTime.now();
  const approximateRangeEnd = endDate
    ? // Mint trend months are strange and daily balances may be present after the end of the reported
      // month (anecodotally observed daily balances 10 days into the first month that showed a zero
      // monthly balance).
      DateTime.fromISO(endDate).plus({ month: 1 }).endOf('month')
    : now;

  // then fetch balances for each period in the range
  return Interval.fromDateTimes(
    DateTime.fromISO(startDate).startOf('month'),
    (approximateRangeEnd < now ? approximateRangeEnd : now).endOf('day'),
  );
};

/**
 * Determine earliest date for which account has balance history, and return 43 day intervals from then to now.
 */
const fetchIntervalsForAccountHistory = async ({
  accountId,
  overrideApiKey,
}: {
  accountId: string;
  overrideApiKey?: string;
}) => {
  // fetch monthly balances so we can get start date
  const balanceInfo = await withRetry(() =>
    fetchMonthlyBalancesForAccount({ accountId, overrideApiKey }),
  );

  if (!balanceInfo) {
    throw new Error('Unable to fetch account history.');
  }

  const { balancesByDate: monthlyBalances, reportType } = balanceInfo;
  const interval = calculateIntervalForAccountHistory(monthlyBalances);
  const periods = interval.splitBy({
    days: MINT_DAILY_TRENDS_MAX_DAYS,
  }) as Interval[];

  return { periods, reportType };
};

/**
 * Fetch balance history for each month for one or more accounts.
 */
const fetchDailyBalances = async ({
  periods,
  accountId,
  reportType,
  overrideApiKey,
  onProgress,
}: {
  periods: Interval[];
  accountId: string | string[];
  reportType: string;
  excludeSpecifiedAccounts?: boolean;
  overrideApiKey?: string;
  onProgress?: ProgressCallback;
}) => {
  if (!reportType) {
    throw new Error('Invalid report type.');
  }

  const accountIds = Array.isArray(accountId) ? accountId : [accountId];
  const counter = {
    count: 0,
  };

  const dailyBalancesByPeriod = await withRateLimit()(
    periods.map(
      ({ start, end }) =>
        () =>
          withRetry(() =>
            fetchTrends({
              reportType,
              filters: accountIds.map(makeAccountIdFilter),
              dateFilter: {
                type: 'CUSTOM',
                startDate: start.toISODate(),
                endDate: end < DateTime.now() ? end.toISODate() : DateTime.now().toISODate(),
              },
              overrideApiKey,
            })
              .then((response) => response.json())
              .then(({ Trend }) => {
                if (!Trend) {
                  // Trend is omitted when request times out
                  throw new Error('Trend timeout');
                }
                return Trend.map(({ amount, type, ...rest }) => ({
                  ...rest,
                  type,
                  amount: type === 'DEBT' ? -amount : amount,
                }));
              }),
          ).finally(() => {
            counter.count += 1;
            onProgress?.({ complete: counter.count, total: periods.length });
          }),
    ),
  );

  const balancesByDate = dailyBalancesByPeriod.reduce((acc, balances) => acc.concat(balances), []);

  return balancesByDate;
};

export const fetchDailyBalancesForAllAccounts = async ({
  onProgress,
  overrideApiKey,
}: {
  onProgress?: BalanceHistoryProgressCallback;
  overrideApiKey?: string;
}) => {
  const accounts = await withRetry(() => fetchAccounts({ overrideApiKey }));

  // first, fetch the range of dates we need to fetch for each account
  const accountsWithPeriodsToFetch = await Promise.all(
    accounts.map(async ({ id: accountId, name: accountName }) => {
      const { periods, reportType } = await withDefaultOnError({ periods: [], reportType: '' })(
        fetchIntervalsForAccountHistory({
          accountId,
          overrideApiKey,
        }),
      );
      return { periods, reportType, accountId, accountName };
    }),
  );

  // one per account per 43 day period
  const totalRequestsToFetch = accountsWithPeriodsToFetch.reduce(
    (acc, { periods }) => acc + periods.length,
    0,
  );

  // fetch one account at a time so we don't hit the rate limit
  const balancesByAccount = await resolveSequential(
    accountsWithPeriodsToFetch.map(
      ({ accountId, accountName, periods, reportType }, accountIndex) =>
        async () => {
          const balances = await withDefaultOnError<TrendEntry[]>([])(
            fetchDailyBalances({
              accountId,
              periods,
              reportType,
              overrideApiKey,
              onProgress: ({ complete }) => {
                // this is the progress handler for *each* account, so we need to sum up the results before calling onProgress

                const previousAccounts = accountsWithPeriodsToFetch.slice(0, accountIndex);
                // since accounts are fetched sequentially, we can assume that all previous accounts have completed all their requests
                const previousCompletedRequestCount = previousAccounts.reduce(
                  (acc, { periods }) => acc + periods.length,
                  0,
                );
                const completedRequests = previousCompletedRequestCount + complete;

                onProgress?.({
                  completedAccounts: accountIndex,
                  totalAccounts: accounts.length,
                  completePercentage: completedRequests / totalRequestsToFetch,
                });
              },
            }),
          );

          return {
            balances,
            accountName,
          };
        },
    ),
  );

  return balancesByAccount;
};

export const fetchDailyBalancesForTrend = async ({
  trend,
  onProgress,
  overrideApiKey,
}: {
  trend: TrendState;
  onProgress?: TrendBalanceHistoryProgressCallback;
  overrideApiKey?: string;
}) => {
  const accounts = await withRetry(() => fetchTrendAccounts({ trend, overrideApiKey }));
  const { reportType, fromDate, toDate } = trend;
  const interval = Interval.fromDateTimes(DateTime.fromISO(fromDate), DateTime.fromISO(toDate));
  const periods = interval.splitBy({
    days: MINT_DAILY_TRENDS_MAX_DAYS,
  }) as Interval[];

  // fetch one account at a time so we don't hit the rate limit
  const balances = await withDefaultOnError<TrendEntry[]>([])(
    fetchDailyBalances({
      accountId: accounts.map(({ id }) => id),
      periods,
      reportType,
      overrideApiKey,
      onProgress: ({ complete }) => {
        onProgress?.({
          completePercentage: complete / periods.length,
        });
      },
    }),
  );

  return balances;
};

/**
 * Use internal Mint API to fetch net worth history. Return list of
 * balances for type: "ASSET" and type: "DEBT" for each month.
 */
export const fetchNetWorthBalances = async ({
  offset = 0,
  limit = 1000, // mint default
  overrideApiKey,
}: {
  offset?: number;
  limit?: number;
  overrideApiKey?: string;
}) => {
  const response = await fetchTrends({
    reportType: 'NET_WORTH',
    offset,
    limit,
    overrideApiKey,
  });
  const { Trend: balancesByDate } = await response.json();

  return balancesByDate;
};

const fetchTrends = ({
  reportType,
  filters = [],
  dateFilter = DATE_FILTER_ALL_TIME,
  offset = 0,
  limit = 1000, // mint default
  overrideApiKey,
}: {
  reportType: string;
  filters?: AccountIdFilter[];
  dateFilter?: Record<string, string>;
  offset?: number;
  limit?: number;
  overrideApiKey?: string;
}) =>
  makeMintApiRequest<TrendsResponse>(
    '/pfm/v1/trends',
    {
      method: 'POST',
      headers: MINT_HEADERS,
      body: JSON.stringify({
        reportView: {
          type: reportType,
        },
        dateFilter,
        searchFilters: [
          {
            matchAll: true,
            filters,
          },
        ],
        offset,
        limit,
      }),
    },
    overrideApiKey,
  );

/**
 * Use internal Mint API to fetch all of user's accounts.
 */
export const fetchAccounts = async ({
  offset = 0,
  limit = 1000, // mint default
  overrideApiKey,
}: FetchAccountsOptions) => {
  const response = await makeMintApiRequest<AccountsResponse>(
    `/pfm/v1/accounts?offset=${offset}&limit=${limit}`,
    {
      headers: MINT_HEADERS,
    },
    overrideApiKey,
  );
  const { Account: accounts } = await response.json();

  return accounts;
};

/**
 * Make sense of the {@link TrendState} by determining which accounts are selected.
 */
export const fetchTrendAccounts = async ({
  trend,
  ...options
}: {
  trend: TrendState;
} & FetchAccountsOptions) => {
  // Mint knows best which accounts are eligible for the trend if nothing is selected
  if (!trend.deselectedAccountIds?.length) {
    return [];
  }
  const allAccounts = await fetchAccounts({ offset: 0, ...options });
  const accountTypeFilter = getAccountTypeFilterForTrend(trend);

  return allAccounts.filter(
    ({ id, type }) => accountTypeFilter(type) && !trend.deselectedAccountIds?.includes(id),
  );
};

/**
 * Merges paired API response into a single amount/inverseAmount entry.
 *
 * The API response does not include an entry for zero inverse amounts, but there is always a
 * positive amount for each date in the trend.
 */
const zipTrendEntries = (trendEntries: TrendEntry[]) => {
  const mergedTrendEntries: TrendEntry[] = [];
  for (let i = 0; i < trendEntries.length; i += 1) {
    const trendEntry = trendEntries[i];
    const nextTrendEntry = trendEntries[i + 1];
    let inverseAmount = 0;
    // If the next entry is the inverse of this one, consume it
    if (nextTrendEntry && nextTrendEntry.type !== trendEntry.type) {
      i += 1;
      inverseAmount = nextTrendEntry.amount;
    }
    mergedTrendEntries.push({
      ...trendEntry,
      inverseAmount,
    });
  }
  return mergedTrendEntries;
};

export const formatBalancesAsCSV = ({
  balances,
  accountName,
  reportType,
}: {
  balances: TrendEntry[];
  accountName?: string;
  reportType?: ReportType;
}) => {
  const header = ['Date'];
  const columns: (keyof TrendEntry | ((trendEntry: TrendEntry) => string | number))[] = ['date'];
  let trendEntries = balances;
  // net income/worth reports have two rows per date, CSV needs one row with two columns
  if (reportType?.startsWith('NET_')) {
    // merge the positive and negative balances into one row
    trendEntries = zipTrendEntries(balances);
    if (reportType === 'NET_INCOME') {
      header.push('Income', 'Expenses');
    } else {
      header.push('Assts', 'Debts');
    }
    header.push('Net');
    columns.push('amount', 'inverseAmount', (trendEntry) =>
      (trendEntry.amount - trendEntry.inverseAmount).toFixed(2),
    );
  } else {
    header.push('Amount');
    columns.push('amount');
  }
  const maybeAccountColumn: [string?] = [];
  if (accountName) {
    header.push('Account Name');
    maybeAccountColumn.push(accountName);
  }
  // remove zero balances from the end of the report leaving just the first row if all are zero
  const rows = trendEntries.reduceRight(
    (acc, trendEntry, index) => {
      if (acc.length || trendEntry.amount !== 0 || trendEntry.inverseAmount || index === 0) {
        acc.unshift([
          ...columns.map((col) => (typeof col === 'function' ? col(trendEntry) : trendEntry[col])),
          ...maybeAccountColumn,
        ]);
      }
      return acc;
    },
    [] as (string | number)[][],
  );

  return formatCSV([header, ...rows]);
};

const makeAccountIdFilter = (accountId: string): AccountIdFilter => ({
  type: 'AccountIdFilter',
  accountId,
});
