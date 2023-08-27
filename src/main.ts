import dotenv from 'dotenv';
import { Scallop, ScallopClient } from '@scallop-io/sui-scallop-sdk';
import {
    borrowAsset,
    depositCollateral,
    getObligationAccount,
} from './scallop';

dotenv.config();

const sdk = new Scallop({
    secretKey: process.env.SECRET_KEY,
    networkType: process.env.NETWORK_TYPE === 'mainnet' ? 'mainnet' : 'testnet',
    fullnodeUrls: [process.env.FULLNODE_URL ?? ''],
});

const main = async () => {
    const scallopClient = await sdk.createScallopClient();
    console.log(`You are executing with address: ${scallopClient.walletAddress}.`);
    const obligation = await getObligationAccount(scallopClient);
    if (obligation) {
        while (true) {
            //deposit collateral
            const deposit = await depositCollateral(
                scallopClient,
                obligation.id
            );
            console.log(`Deposit : ${deposit?.digest}`);

            //borrow
            const { digest: digestBorrow } = await borrowAsset(
              scallopClient,
              obligation
            )
        }
    }
};

main();
