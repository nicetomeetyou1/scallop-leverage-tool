import {
    ObligationInterface,
    ScallopClient, SupportAssetCoins, ScallopUtils, MarketDataInterface, CollateralPoolInterface
} from '@scallop-io/sui-scallop-sdk';
import BigNumber from 'bignumber.js';

const USDC_COIN_TYPE =
    '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN';

type AssetMarketData = {
    coin: SupportAssetCoins;
    coinType: string;
    borrowWeight: number;
    calculated: {
        borrowIndex: number;
    }
}

type AccountObligation = {
    id: string;
    keyId: string;
    data: ObligationInterface;
}

const scallopUtils = new ScallopUtils({});
export const getObligationAccount = async (
    client: ScallopClient
): Promise<AccountObligation> => {
    const obligations = await client.getObligations(client.walletAddress);
    let selectedObligation: AccountObligation;
    for (const obligation of obligations) {
        const obligationData = await client.queryObligation(obligation.id);
        if (obligationData.collaterals.length > 0) {
            selectedObligation = {
                ...obligation,
                data: obligationData
            };
        }
    }
    return selectedObligation;
};

export const depositCollateral = async (
    client: ScallopClient,
    obligationId: string
) => {
    const amountUSDC = await getUsdcAmount(client);
    if(amountUSDC > 0) {
        return await client.depositCollateral(
          'usdc',
          amountUSDC,
          true,
          obligationId
        );
    }
};

export const borrowAsset = async (
    client: ScallopClient,
    obligation: AccountObligation
) => {
    const getAvailableCollateral = await calculatedAvailableCollateral(client, obligation);
    const usdcMetadata = await getCoinMetadaData(client, USDC_COIN_TYPE);
    const price = await getPriceFromOracle(client, 'usdc', 'pyth');
    const marketData = await getMarketData(client);
    const borrowWeight = marketData.assets.find((value) => value.coinType === USDC_COIN_TYPE);

    const totalBorrow = BigNumber(getAvailableCollateral).minus(0.1)
      .dividedBy(price)
      .multipliedBy(borrowWeight.borrowWeight)
      .multipliedBy(0.99)
      .shiftedBy(usdcMetadata.decimals)
      .integerValue(BigNumber.ROUND_DOWN)
      .toNumber();
    console.log(totalBorrow)

    return await client.borrow(
        'usdc',
        totalBorrow,
        true,
        obligation.id,
        obligation.keyId
    );
};

export const getMarketData = async (client: ScallopClient) : Promise<{assets: AssetMarketData[], collaterals: CollateralPoolInterface[]}> => {
    const response = await client.queryMarket();
    const assetsMarketData : AssetMarketData[] = [];
    for (const assets of response.assets) {
        assetsMarketData.push({
            coin: assets.coin,
            coinType: assets.coinType,
            borrowWeight: assets.origin.borrowWeight,
            calculated: {
                borrowIndex: assets.calculated.currentBorrowIndex
            }
        });
    }
    return {
        assets: assetsMarketData,
        collaterals: response.collaterals
    };
};

// Calculate all collateral deposited by user
export const calculatedAvailableCollateral = async (client: ScallopClient, accountData: AccountObligation) => {
    let totalCollateralAmount = BigNumber(0);
    let totalCollateralValue = BigNumber(0);
    let totalBorrowCapacityValue = BigNumber(0);
    //  how much collateral is required to be avoided liquidated
    let totalDebtAmount = BigNumber(0);
    let totalDebtValue = BigNumber(0);
    let totalDebtValueWithWeight = BigNumber(0);

    const marketData = await getMarketData(client);

    for(const collateral of accountData.data.collaterals) {
        const cType = '0x' + collateral.type.name;
        const coin = scallopUtils.getCoinNameFromCoinType(cType);
        const price = await getPriceFromOracle(client, coin, 'pyth');
        const coinMetaData = await getCoinMetadaData(client, cType);
        const collateralPool = marketData.collaterals.find(({ coinType }) => cType === coinType);

        if(price && coinMetaData && collateralPool) {
            const collateralAmount = BigNumber(collateral.amount).shiftedBy(-1 * coinMetaData.decimals);
            const collateralValue = collateralAmount.multipliedBy(price);
            const borrowCapacity = collateralValue.multipliedBy(collateralPool.origin.collateralFactor);
            const requiredCollateral = collateralValue.multipliedBy(collateralPool.origin.liquidationFactor);
            totalCollateralAmount = totalCollateralAmount.plus(collateralAmount);
            totalCollateralValue = totalCollateralValue.plus(collateralValue);
            totalBorrowCapacityValue = totalBorrowCapacityValue.plus(borrowCapacity);
        }
    }

    for(const debt of accountData.data.debts) {
        const cType = '0x' + debt.type.name;
        const coin = scallopUtils.getCoinNameFromCoinType(cType);
        const marketData = await getMarketData(client);
        const assetInfo = marketData.assets.find(({ coinType }) => cType === coinType);
        const coinMetadata = await getCoinMetadaData(client, cType);
        const price = await getPriceFromOracle(client, coin, 'pyth');
        const increaseRate = assetInfo.calculated.borrowIndex / Number(debt.borrowIndex) - 1;
        const debAmount = BigNumber(debt.amount).shiftedBy(-1 * coinMetadata.decimals).multipliedBy(increaseRate + 1);
        const debtValue = debAmount.multipliedBy(price);
        const debtValueWithWeight = debtValue.multipliedBy(assetInfo.borrowWeight);
        totalDebtAmount = totalDebtAmount.plus(debAmount);
        totalDebtValue = totalDebtValue.plus(debtValue);
        totalDebtValueWithWeight = totalDebtValueWithWeight.plus(debtValueWithWeight);
    }

    return Math.max(0, totalBorrowCapacityValue.minus(totalDebtValueWithWeight).toNumber());
}

export const getUsdcAmount = async (client: ScallopClient): Promise<number> => {
    const usdc = await client.suiKit.getBalance(USDC_COIN_TYPE);
    return Number(usdc.totalBalance);
};

export const getCoinMetadaData = async (client: ScallopClient, coinType: string) => {
    return await client.suiKit.suiInteractor.currentProvider.getCoinMetadata({
        coinType
    });
}

export const getPriceFromOracle = async (client: ScallopClient, coin: SupportAssetCoins, oracle: 'pyth') => {
    let price = 0;
    if(oracle === 'pyth') {
        const coinPrice = await client.suiKit.getObjects([
            client.address.get(`core.coins.${coin}.oracle.pyth.feedObject`)
        ])
        if(coinPrice.length > 0) {
                const { magnitude: expoMagnitude, negative: expoNegative } =
                  coinPrice[0].objectFields?.price_info.fields.price_feed.fields.price.fields
                    .expo.fields;
                const { magnitude, negative } =
                  coinPrice[0].objectFields?.price_info.fields.price_feed.fields.price.fields
                    .price.fields;
                price =
                  magnitude * 10 ** ((expoNegative ? -1 : 1) * expoMagnitude) * (negative ? -1 : 1);
        }
    }
    return price;
}
