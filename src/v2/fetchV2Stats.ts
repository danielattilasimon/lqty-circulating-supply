import type { BlockTag, Provider } from "@ethersproject/abstract-provider";
import type { BigNumber } from "@ethersproject/bignumber";
import { resolveProperties } from "@ethersproject/properties";
import { Decimal } from "@liquity/lib-base";

import { getContracts, type LiquityV2Deployment } from "./contracts.js";

const ONE_WEI = Decimal.fromBigNumberString("1");

const decimalify = (bigNumber: BigNumber) => Decimal.fromBigNumberString(bigNumber.toHexString());

const mapObj = <T extends Record<string, any>, U>(t: T, f: (v: T[keyof T]) => U) =>
  Object.fromEntries(Object.entries(t).map(([k, v]) => [k, f(v)])) as { [K in keyof T]: U };

export const fetchV2Stats = async (
  provider: Provider,
  deployment: LiquityV2Deployment,
  blockTag: BlockTag = "latest"
) => {
  const SP_YIELD_SPLIT = Number(Decimal.fromBigNumberString(deployment.constants.SP_YIELD_SPLIT));
  const contracts = getContracts(provider, deployment);

  const [total_bold_supply, branches] = await Promise.all([
    contracts.boldToken.totalSupply({ blockTag }).then(decimalify),

    Promise.all(
      contracts.branches.map(branch =>
        resolveProperties({
          coll_symbol: branch.collToken.symbol({ blockTag }),
          coll_active: branch.activePool.getCollBalance({ blockTag }).then(decimalify),
          coll_default: branch.defaultPool.getCollBalance({ blockTag }).then(decimalify),
          coll_price: branch.priceFeed.callStatic
            .fetchPrice({ blockTag })
            .then(([x]) => x)
            .then(decimalify),
          sp_deposits: branch.stabilityPool.getTotalBoldDeposits({ blockTag }).then(decimalify),
          interest_accrual_1y: branch.activePool
            .aggWeightedDebtSum({ blockTag })
            .then(decimalify)
            .then(x => x.mul(ONE_WEI)),
          interest_pending: branch.activePool.calcPendingAggInterest({ blockTag }).then(decimalify),
          batch_management_fees_pending: Promise.all([
            branch.activePool.aggBatchManagementFees({ blockTag }).then(decimalify),
            branch.activePool.calcPendingAggBatchManagementFee({ blockTag }).then(decimalify)
          ]).then(([a, b]) => a.add(b))
        })
          .then(branch => ({
            ...branch,
            debt_pending: branch.interest_pending.add(branch.batch_management_fees_pending),
            coll_value: branch.coll_active.add(branch.coll_default).mul(branch.coll_price),
            sp_apy:
              (SP_YIELD_SPLIT * Number(branch.interest_accrual_1y)) / Number(branch.sp_deposits)
          }))
          .then(branch => ({
            ...branch,
            value_locked: branch.coll_value.add(branch.sp_deposits) // taking BOLD at face value
          }))
      )
    )
  ]);

  const sp_apys = branches.map(b => b.sp_apy).filter(x => !isNaN(x));

  return {
    total_bold_supply: `${total_bold_supply}`,
    total_debt_pending: `${branches.map(b => b.debt_pending).reduce((a, b) => a.add(b))}`,
    total_coll_value: `${branches.map(b => b.coll_value).reduce((a, b) => a.add(b))}`,
    total_sp_deposits: `${branches.map(b => b.sp_deposits).reduce((a, b) => a.add(b))}`,
    total_value_locked: `${branches.map(b => b.value_locked).reduce((a, b) => a.add(b))}`,
    max_sp_apy: `${sp_apys.length > 0 ? Math.max(...sp_apys) : NaN}`,

    branch: Object.fromEntries(
      branches.map(({ coll_symbol, ...b }) => [coll_symbol, mapObj(b, x => `${x}`)])
    )
  };
};
