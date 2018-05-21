import { LogWithDecodedArgs, ZeroEx } from '0x.js';
import { BlockchainLifecycle } from '@0xproject/dev-utils';
import { BigNumber } from '@0xproject/utils';
import * as chai from 'chai';
import * as _ from 'lodash';
import * as Web3 from 'web3';

import {
    MultiSigWalletWithTimeLockContract,
    SubmissionContractEventArgs,
} from '../src/contract_wrappers/generated/multi_sig_wallet_with_time_lock';
import { artifacts } from '../src/utils/artifacts';
import { chaiSetup } from '../src/utils/chai_setup';
import { constants } from '../src/utils/constants';
import { MultiSigWrapper } from '../src/utils/multi_sig_wrapper';
import { provider, txDefaults, web3Wrapper } from '../src/utils/web3_wrapper';

chaiSetup.configure();
const expect = chai.expect;
const blockchainLifecycle = new BlockchainLifecycle(web3Wrapper);
const zeroEx = new ZeroEx(provider, { networkId: constants.TESTRPC_NETWORK_ID });

describe('MultiSigWalletWithTimeLock', () => {
    let owners: string[];
    const requiredApprovals = new BigNumber(2);
    const SECONDS_TIME_LOCKED = new BigNumber(1000000);

    before(async () => {
        const accounts = await web3Wrapper.getAvailableAddressesAsync();
        owners = [accounts[0], accounts[1]];
    });

    let multiSig: MultiSigWalletWithTimeLockContract;
    let multiSigWrapper: MultiSigWrapper;

    beforeEach(async () => {
        await blockchainLifecycle.startAsync();
    });
    afterEach(async () => {
        await blockchainLifecycle.revertAsync();
    });

    describe('changeTimeLock', () => {
        describe('initially non-time-locked', async () => {
            before('deploy a wallet', async () => {
                const secondsTimeLocked = new BigNumber(0);
                multiSig = await MultiSigWalletWithTimeLockContract.deployFrom0xArtifactAsync(
                    artifacts.MultiSigWalletWithTimeLock,
                    provider,
                    txDefaults,
                    owners,
                    requiredApprovals,
                    secondsTimeLocked,
                );
                multiSigWrapper = new MultiSigWrapper(multiSig, zeroEx);
            });

            it('should throw when not called by wallet', async () => {
                return expect(
                    multiSig.changeTimeLock.sendTransactionAsync(SECONDS_TIME_LOCKED, { from: owners[0] }),
                ).to.be.rejectedWith(constants.REVERT);
            });

            it('should throw without enough confirmations', async () => {
                const destination = multiSig.address;
                const changeTimeLockData = multiSig.changeTimeLock.getABIEncodedTransactionData(SECONDS_TIME_LOCKED);
                const res = await multiSigWrapper.submitTransactionAsync(destination, changeTimeLockData, owners[0]);
                const log = res.logs[0] as LogWithDecodedArgs<SubmissionContractEventArgs>;
                const txId = log.args.transactionId;

                return expect(
                    multiSig.executeTransaction.sendTransactionAsync(txId, { from: owners[0] }),
                ).to.be.rejectedWith(constants.REVERT);
            });

            it('should set confirmation time with enough confirmations', async () => {
                const destination = multiSig.address;
                const changeTimeLockData = multiSig.changeTimeLock.getABIEncodedTransactionData(SECONDS_TIME_LOCKED);
                const subRes = await multiSigWrapper.submitTransactionAsync(destination, changeTimeLockData, owners[0]);
                const subLog = subRes.logs[0] as LogWithDecodedArgs<SubmissionContractEventArgs>;
                const txId = subLog.args.transactionId;

                const confirmRes = await multiSigWrapper.confirmTransactionAsync(txId, owners[1]);
                expect(confirmRes.logs).to.have.length(2);

                const blockNum = await web3Wrapper.getBlockNumberAsync();
                const blockInfo = await web3Wrapper.getBlockAsync(blockNum);
                const timestamp = new BigNumber(blockInfo.timestamp);
                const confirmationTimeBigNum = new BigNumber(await multiSig.confirmationTimes.callAsync(txId));

                expect(timestamp).to.be.bignumber.equal(confirmationTimeBigNum);
            });

            it('should be executable with enough confirmations and secondsTimeLocked of 0', async () => {
                const destination = multiSig.address;
                const changeTimeLockData = multiSig.changeTimeLock.getABIEncodedTransactionData(SECONDS_TIME_LOCKED);
                const subRes = await multiSigWrapper.submitTransactionAsync(destination, changeTimeLockData, owners[0]);
                const subLog = subRes.logs[0] as LogWithDecodedArgs<SubmissionContractEventArgs>;
                const txId = subLog.args.transactionId;

                await multiSigWrapper.confirmTransactionAsync(txId, owners[1]);
                await multiSigWrapper.executeTransactionAsync(txId, owners[1]);

                const secondsTimeLocked = new BigNumber(await multiSig.secondsTimeLocked.callAsync());
                expect(secondsTimeLocked).to.be.bignumber.equal(SECONDS_TIME_LOCKED);
            });
        });
        describe('initially time-locked', async () => {
            before('deploy a wallet, submit transaction to change timelock, and confirm the transaction', async () => {
                let txId: BigNumber;
                const newSecondsTimeLocked = new BigNumber(0);
                multiSig = await MultiSigWalletWithTimeLockContract.deployFrom0xArtifactAsync(
                    artifacts.MultiSigWalletWithTimeLock,
                    provider,
                    txDefaults,
                    owners,
                    requiredApprovals,
                    SECONDS_TIME_LOCKED,
                );
                multiSigWrapper = new MultiSigWrapper(multiSig, zeroEx);

                const changeTimeLockData = multiSig.changeTimeLock.getABIEncodedTransactionData(newSecondsTimeLocked);
                const res = await multiSigWrapper.submitTransactionAsync(
                    multiSig.address,
                    changeTimeLockData,
                    owners[0],
                );
                const log = res.logs[0] as LogWithDecodedArgs<SubmissionContractEventArgs>;
                txId = log.args.transactionId;
                await multiSigWrapper.confirmTransactionAsync(txId, owners[1]);
            });
            it('should throw if it has enough confirmations but is not past the time lock', async () => {
                return expect(
                    multiSig.executeTransaction.sendTransactionAsync(txId, { from: owners[0] }),
                ).to.be.rejectedWith(constants.REVERT);
            });

            it('should execute if it has enough confirmations and is past the time lock', async () => {
                await web3Wrapper.increaseTimeAsync(SECONDS_TIME_LOCKED.toNumber());
                await multiSig.executeTransaction.sendTransactionAsync(txId, { from: owners[0] });

                const secondsTimeLocked = new BigNumber(await multiSig.secondsTimeLocked.callAsync());
                expect(secondsTimeLocked).to.be.bignumber.equal(newSecondsTimeLocked);
            });
        });
    });
});
