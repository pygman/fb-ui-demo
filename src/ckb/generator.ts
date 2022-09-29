import { Cell, Script, Indexer, WitnessArgs, core, utils } from '@ckb-lumos/base';
import { common } from '@ckb-lumos/common-scripts';
import {
  minimalCellCapacity,
  parseAddress,
  TransactionSkeleton,
  TransactionSkeletonType,
  createTransactionFromSkeleton,
} from '@ckb-lumos/helpers';
import { Reader, normalizers } from 'ckb-js-toolkit';
import * as lodash from 'lodash';
import { asserts, nonNullable } from './error';
import { asyncSleep, fromHexString, stringToUint8Array, toHexString, transactionSkeletonToJSON } from './utils';
import { CkbTxHelper } from './base_generator';
import { SerializeRecipientCellData } from './generated/eth_recipient_cell';
import {ScriptType, SearchKey} from './indexer';
import { getMultisigLock, getOwnerTypeHash } from './multisig_helper';
import ForceBridgeCore from '../config/ForceBridgeCore.json';
import {Asset} from "./model/asset";
import {CellDep} from "@ckb-lumos/lumos";
import {SerializeRcLockWitnessLock} from "@ckitjs/rc-lock";

export class CkbTxGenerator extends CkbTxHelper {
  sudtDep = {
    out_point: {
      tx_hash: ForceBridgeCore.config.ckb.deps.sudtType.cellDep.outPoint.txHash,
      index: ForceBridgeCore.config.ckb.deps.sudtType.cellDep.outPoint.index,
    },
    dep_type: ForceBridgeCore.config.ckb.deps.sudtType.cellDep.depType,
  } as CellDep;

  recipientDep = {
    out_point: {
      tx_hash: ForceBridgeCore.config.ckb.deps.recipientType.cellDep.outPoint.txHash,
      index: ForceBridgeCore.config.ckb.deps.recipientType.cellDep.outPoint.index,
    },
    dep_type: ForceBridgeCore.config.ckb.deps.recipientType.cellDep.depType,
  } as CellDep;

  bridgeLockDep = {
    out_point: {
      tx_hash: ForceBridgeCore.config.ckb.deps.bridgeLock.cellDep.outPoint.txHash,
      index: ForceBridgeCore.config.ckb.deps.bridgeLock.cellDep.outPoint.index,
    },
    dep_type: ForceBridgeCore.config.ckb.deps.bridgeLock.cellDep.depType,
  } as CellDep;

  constructor(ckbRpcUrl: string, ckbIndexerUrl: string) {
    super(ckbRpcUrl, ckbIndexerUrl);
  }

  /*
    table RecipientCellData {
      recipient_address: Bytes,
      chain: byte,
      asset: Bytes,
      bridge_lock_code_hash: Byte32,
      owner_lock_hash: Byte32,
      amount: Uint128,
    }
   */
  async burn(
    fromLockscript: Script,
    recipientAddress: string,
    asset: Asset,
    amount: bigint,
  ): Promise<TransactionSkeletonType> {
    if (amount === 0n) {
      throw new Error('amount should larger then zero!');
    }
    // get sudt cells
    const bridgeCellLockscript = {
      code_hash: ForceBridgeCore.config.ckb.deps.bridgeLock.script.codeHash,
      hash_type: ForceBridgeCore.config.ckb.deps.bridgeLock.script.hashType,
      args: asset.toBridgeLockscriptArgs(),
    };
    const args = utils.computeScriptHash(bridgeCellLockscript as Script);
    const searchKey = {
      script: fromLockscript,
      script_type: ScriptType.lock,
      filter: {
        script: {
          code_hash: ForceBridgeCore.config.ckb.deps.sudtType.script.codeHash,
          args,
          hash_type: ForceBridgeCore.config.ckb.deps.sudtType.script.hashType,
        },
      },
    };
    const sudtCells = await this.collector.collectSudtByAmount(searchKey as SearchKey, amount);
    const total = sudtCells.map((cell) => utils.readBigUInt128LE(cell.data)).reduce((a, b) => a + b, 0n);
    if (total < amount) {
      throw new Error('sudt amount is not enough!');
    }
    console.debug('burn sudtCells: ', sudtCells);
    let txSkeleton = TransactionSkeleton({ cellProvider: this.indexer });
    txSkeleton = txSkeleton.update('inputs', (inputs) => {
      return inputs.concat(sudtCells);
    });

    // add recipient output cell
    const ownerCellTypeHash = getOwnerTypeHash();
    const recipientAddr = fromHexString(toHexString(stringToUint8Array(recipientAddress))).buffer;
    let hashType;
    switch (ForceBridgeCore.config.ckb.deps.bridgeLock.script.hashType) {
      case 'data':
        hashType = 0;
        break;
      case 'type':
        hashType = 1;
        break;
      default:
        throw new Error('invalid hash type');
    }

    const params = {
      recipient_address: recipientAddr,
      chain: asset.chainType,
      asset: fromHexString(toHexString(stringToUint8Array(asset.getAddress()))).buffer,
      amount: fromHexString(utils.toBigUInt128LE(amount)).buffer,
      bridge_lock_code_hash: fromHexString(ForceBridgeCore.config.ckb.deps.bridgeLock.script.codeHash).buffer,
      bridge_lock_hash_type: hashType,
      owner_cell_type_hash: fromHexString(ownerCellTypeHash).buffer,
    };

    const recipientCellData = `0x${toHexString(new Uint8Array(SerializeRecipientCellData(params)))}`;
    const recipientTypeScript = {
      code_hash: ForceBridgeCore.config.ckb.deps.recipientType.script.codeHash,
      hash_type: ForceBridgeCore.config.ckb.deps.recipientType.script.hashType,
      args: '0x',
    };
    const recipientOutput: Cell = {
      cell_output: {
        lock: fromLockscript,
        type: recipientTypeScript as Script,
        capacity: '0x0',
      },
      data: recipientCellData,
    };
    const recipientCapacity = minimalCellCapacity(recipientOutput);
    recipientOutput.cell_output.capacity = `0x${recipientCapacity.toString(16)}`;
    console.debug(`recipientOutput`, recipientOutput);
    console.debug(`txSkeleton: ${transactionSkeletonToJSON(txSkeleton)}`);
    txSkeleton = txSkeleton.update('outputs', (outputs) => {
      return outputs.push(recipientOutput);
    });
    console.debug(`txSkeleton: ${transactionSkeletonToJSON(txSkeleton)}`);
    // sudt change cell
    const changeAmount = total - amount;
    if (changeAmount > 0n) {
      const sudtChangeCell: Cell = lodash.cloneDeep(sudtCells[0]);
      sudtChangeCell.data = utils.toBigUInt128LE(changeAmount);
      const sudtChangeCellCapacity = minimalCellCapacity(sudtChangeCell);
      sudtChangeCell.cell_output.capacity = `0x${sudtChangeCellCapacity.toString(16)}`;
      txSkeleton = txSkeleton.update('outputs', (outputs) => {
        return outputs.push(sudtChangeCell);
      });
    }
    // add cell deps
    txSkeleton = txSkeleton.update('cellDeps', (cellDeps) => {
      const secp256k1 = nonNullable(this.lumosConfig.SCRIPTS.SECP256K1_BLAKE160);
      return cellDeps
        .push({
          out_point: {
            tx_hash: secp256k1.TX_HASH,
            index: secp256k1.INDEX,
          },
          dep_type: secp256k1.DEP_TYPE,
        })
        .push(this.sudtDep)
        .push(this.recipientDep);
    });

    // add change output
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
    // add inputs
    const fee = 100000n;
    const capacityDiff = await this.calculateCapacityDiff(txSkeleton);
    console.debug(`capacityDiff`, capacityDiff);
    const needCapacity = -capacityDiff + fee;
    if (needCapacity < 0) {
      txSkeleton = txSkeleton.update('outputs', (outputs) => {
        changeOutput.cell_output.capacity = `0x${(minimalChangeCellCapacity - needCapacity).toString(16)}`;
        return outputs.set(outputs.size - 1, changeOutput);
      });
    } else {
      const fromCells = await this.collector.getCellsByLockscriptAndCapacity(fromLockscript, needCapacity);
      console.debug(`fromCells: ${JSON.stringify(fromCells, null, 2)}`);
      txSkeleton = txSkeleton.update('inputs', (inputs) => {
        return inputs.concat(fromCells);
      });
      const capacityDiff = await this.calculateCapacityDiff(txSkeleton);
      if (capacityDiff < fee) {
        const humanReadableCapacityDiff = -capacityDiff / 100000000n + 1n; // 1n is 1 ckb to supply fee
        throw new Error(`fromAddress capacity insufficient, need ${humanReadableCapacityDiff.toString()} CKB more`);
      }
      txSkeleton = txSkeleton.update('outputs', (outputs) => {
        changeOutput.cell_output.capacity = `0x${(minimalChangeCellCapacity + capacityDiff - fee).toString(16)}`;
        return outputs.set(outputs.size - 1, changeOutput);
      });
    }

    const omniLockConfig = ForceBridgeCore.config.ckb.deps.omniLock;
    if (
      omniLockConfig &&
      fromLockscript.code_hash === omniLockConfig.script.codeHash &&
      fromLockscript.hash_type === omniLockConfig.script.hashType
    ) {
      txSkeleton = txSkeleton.update('cellDeps', (cellDeps) => {
        return cellDeps.push({
          out_point: {
            tx_hash: omniLockConfig.cellDep.outPoint.txHash,
            index: omniLockConfig.cellDep.outPoint.index,
          },
          dep_type: omniLockConfig.cellDep.depType,
        } as CellDep);
      });

      console.log(1111111111111111111111111111111111111);
      console.log(JSON.stringify(txSkeleton));
      console.log(1111111111111111111111111111111111111);
      const messageToSign = (() => {
        const hasher = new utils.CKBHasher();
        const rawTxHash = utils.ckbHash(
          core.SerializeRawTransaction(normalizers.NormalizeRawTransaction(createTransactionFromSkeleton(txSkeleton))),
        );
        // serialized unsigned witness
        const serializedWitness = core.SerializeWitnessArgs({
          lock: new Reader(
            '0x' +
              '00'.repeat(
                SerializeRcLockWitnessLock({
                  signature: new Reader('0x' + '00'.repeat(65)),
                }).byteLength,
              ),
          ),
        });
        hasher.update(rawTxHash);
        const lengthBuffer = new ArrayBuffer(8);
        const view = new DataView(lengthBuffer);
        view.setBigUint64(0, BigInt(new Reader(serializedWitness).length()), true);

        hasher.update(lengthBuffer);
        hasher.update(serializedWitness);
        return hasher.digestHex();
      })();

      txSkeleton = txSkeleton.update('signingEntries', (signingEntries) => {
        return signingEntries.push({
          type: 'witness_args_lock',
          index: 0,
          message: messageToSign,
        });
      });
    }

    console.debug(`txSkeleton: ${transactionSkeletonToJSON(txSkeleton)}`);
    console.debug(`final fee: ${await this.calculateCapacityDiff(txSkeleton)}`);

    return txSkeleton;
  }
}

function transformScript(script: Script | undefined | null): CKBComponents.Script | null {
  if (script === undefined || script === null) {
    return null;
  }
  return {
    args: script.args,
    codeHash: script.code_hash,
    hashType: script.hash_type,
  };
}

export function txSkeletonToRawTransactionToSign(
  txSkeleton: TransactionSkeletonType,
): CKBComponents.RawTransactionToSign {
  const inputs = txSkeleton
    .get('inputs')
    .toArray()
    .map((input) => {
      return <CKBComponents.CellInput>{
        previousOutput: {
          txHash: input.out_point!.tx_hash,
          index: input.out_point!.index,
        },
        since: '0x0',
      };
    });
  const outputs = txSkeleton
    .get('outputs')
    .toArray()
    .map((output) => {
      return {
        capacity: output.cell_output.capacity,
        lock: transformScript(output.cell_output.lock),
        type: transformScript(output.cell_output.type),
      };
    });
  const outputsData = txSkeleton
    .get('outputs')
    .toArray()
    .map((output) => output.data);
  const cellDeps = txSkeleton
    .get('cellDeps')
    .toArray()
    .map((cellDep) => {
      let depType = 'code';
      if (cellDep.dep_type === 'dep_group') {
        depType = 'depGroup';
      }
      return {
        outPoint: {
          txHash: cellDep.out_point.tx_hash,
          index: cellDep.out_point.index,
        },
        depType,
      };
    });
  const rawTx = {
    version: '0x0',
    cellDeps,
    headerDeps: [],
    inputs,
    outputs,
    witnesses: [{ lock: '', inputType: '', outputType: '' }],
    outputsData,
  };
  console.debug(`generate burn rawTx: ${JSON.stringify(rawTx, null, 2)}`);
  return rawTx as CKBComponents.RawTransactionToSign;
}
