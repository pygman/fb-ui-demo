import { Cell, Script, TransactionWithStatus } from '@ckb-lumos/base';
import { common } from '@ckb-lumos/common-scripts';
import { getConfig, Config } from '@ckb-lumos/config-manager';
import { minimalCellCapacity, parseAddress, TransactionSkeletonType } from '@ckb-lumos/helpers';
import { RPC } from '@ckb-lumos/rpc';
import { asyncSleep, transactionSkeletonToJSON } from './utils';
import { IndexerCollector } from './collector';
import { CkbIndexer, ScriptType, Terminator } from './indexer';
import { predefined } from '@ckb-lumos/config-manager';

// you have to initialize lumos config before use this generator
export class CkbTxHelper {
  ckbRpcUrl: string;
  ckbIndexerUrl: string;
  collector: IndexerCollector;
  indexer: CkbIndexer;
  ckb: RPC;
  lumosConfig: Config;

  constructor(ckbRpcUrl: string, ckbIndexerUrl: string) {
    this.ckbRpcUrl = ckbRpcUrl;
    this.ckbIndexerUrl = ckbIndexerUrl;
    this.indexer = new CkbIndexer(ckbRpcUrl, ckbIndexerUrl);
    this.ckb = new RPC(ckbRpcUrl);
    this.collector = new IndexerCollector(this.indexer);
    this.lumosConfig = predefined.AGGRON4;
    console.debug('lumosConfig', this.lumosConfig);
  }

  async getFromCells(lockscript: Script): Promise<Cell[]> {
    const searchKey = {
      script: lockscript,
      script_type: ScriptType.lock,
    };
    const terminator: Terminator = (index, c) => {
      const cell = c;
      if (cell.data.length / 2 - 1 > 0 || cell.cell_output.type) {
        return { stop: false, push: false };
      } else {
        return { stop: false, push: true };
      }
    };
    const fromCells = await this.indexer.getCells(searchKey, terminator);
    console.debug(`fromCells: ${JSON.stringify(fromCells)}`);
    return fromCells;
  }

  async calculateCapacityDiff(txSkeleton: TransactionSkeletonType): Promise<bigint> {
    const inputCapacity = txSkeleton
      .get('inputs')
      .map((c) => BigInt(c.cell_output.capacity))
      .reduce((a, b) => a + b, 0n);
    const outputCapacity = txSkeleton
      .get('outputs')
      .map((c) => BigInt(c.cell_output.capacity))
      .reduce((a, b) => a + b, 0n);
    return inputCapacity - outputCapacity;
  }

  // add capacity input, change output, pay fee
  async completeTx(
    txSkeleton: TransactionSkeletonType,
    fromAddress: string,
    fromCells?: Cell[],
    feeRate = 1200n,
  ): Promise<TransactionSkeletonType> {
    console.debug(`txSkeleton: ${transactionSkeletonToJSON(txSkeleton)}`);
    // freeze outputs
    txSkeleton = txSkeleton.update('fixedEntries', (fixedEntries) => {
      return fixedEntries.push({
        field: 'outputs',
        index: txSkeleton.get('outputs').size - 1,
      });
    });
    // add change output
    const fromLockscript = parseAddress(fromAddress);
    const changeOutput: Cell = {
      cell_output: {
        capacity: '0x0',
        lock: fromLockscript,
      },
      data: '0x',
    };
    const minimalChangeCellCapacity = minimalCellCapacity(changeOutput);
    changeOutput.cell_output.capacity = `0x${minimalChangeCellCapacity.toString(16)}`;
    txSkeleton = txSkeleton.update('outputs', (outputs) => {
      return outputs.push(changeOutput);
    });
    const capacityDiff = await this.calculateCapacityDiff(txSkeleton);
    console.debug('injectCapacity params', {
      fromAddress,
      capacityDiff,
    });
    if (capacityDiff < 0) {
      txSkeleton = await common.injectCapacity(txSkeleton, [fromAddress], -capacityDiff);
    } else {
      txSkeleton.update('outputs', (outputs) => {
        const before = BigInt(changeOutput.cell_output.capacity);
        const after = before + capacityDiff;
        changeOutput.cell_output.capacity = `0x${after.toString(16)}`;
        return outputs.set(outputs.size - 1, changeOutput);
      });
    }
    console.debug(`txSkeleton: ${transactionSkeletonToJSON(txSkeleton)}`);
    console.debug(`capacity diff: ${await this.calculateCapacityDiff(txSkeleton)}`);
    txSkeleton = await common.payFeeByFeeRate(txSkeleton, [fromAddress], feeRate);
    console.debug(`txSkeleton: ${transactionSkeletonToJSON(txSkeleton)}`);
    console.debug(`final fee: ${await this.calculateCapacityDiff(txSkeleton)}`);
    await asyncSleep(1000);
    return txSkeleton;
  }

  async waitUntilCommitted(txHash: string, timeout = 120): Promise<TransactionWithStatus | null> {
    let waitTime = 0;
    for (;;) {
      const txStatus = await this.ckb.get_transaction(txHash);
      if (txStatus !== null) {
        console.debug(`tx ${txHash}, status: ${txStatus.tx_status.status}, index: ${waitTime}`);
        if (txStatus.tx_status.status === 'committed') {
          return txStatus;
        }
      } else {
        throw new Error(`wait for ${txHash} until committed failed with null txStatus`);
      }
      waitTime += 1;
      if (waitTime > timeout) {
        console.warn('waitUntilCommitted timeout', { txHash, timeout, txStatus });
        throw new Error(`wait for ${txHash} until committed timeout after ${timeout} seconds`);
      }
      await asyncSleep(1000);
    }
  }
}
