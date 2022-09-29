import { HexString, Script } from '@ckb-lumos/base';
import { multisigArgs, serializeMultisigScript } from '@ckb-lumos/common-scripts/lib/from_info';
import { getConfig } from '@ckb-lumos/config-manager';
import { encodeToAddress } from '@ckb-lumos/helpers';
import { nonNullable } from './error';
import ForceBridgeCore from '../config/ForceBridgeCore.json';
import {ForceBridgeCoreCkb} from "../config/ForceBridgeCoreCkb";

interface MultisigItem {
  R: number;
  M: number;
  publicKeyHashes: string[];
}

const config = getConfig();
const multisigTemplate = nonNullable(config.SCRIPTS.SECP256K1_BLAKE160_MULTISIG);
if (!multisigTemplate) {
  throw new Error('Multisig script template missing!');
}

const secpTemplate = nonNullable(getConfig().SCRIPTS.SECP256K1_BLAKE160);

export function getMultisigLock(multisigScript: MultisigItem): Script {
  const serializedMultisigScript = serializeMultisigScript(multisigScript);
  const args = multisigArgs(serializedMultisigScript);
  const multisigLockscript = {
    code_hash: multisigTemplate.CODE_HASH,
    hash_type: multisigTemplate.HASH_TYPE,
    args,
  };
  return multisigLockscript;
}

export function getOwnLockHash(multisigScript: MultisigItem): string {
  const multisigLockscript = getMultisigLock(multisigScript);
  const ownLockHash = ForceBridgeCoreCkb.utils.scriptToHash(<CKBComponents.Script>{
    codeHash: multisigLockscript.code_hash,
    hashType: multisigLockscript.hash_type,
    args: multisigLockscript.args,
  });
  return ownLockHash;
}

export function getOwnerTypeHash(): string {
  const ownerTypeHash = ForceBridgeCoreCkb.utils.scriptToHash(<CKBComponents.Script>{
    codeHash: ForceBridgeCore.config.ckb.ownerCellTypescript.code_hash,
    hashType: ForceBridgeCore.config.ckb.ownerCellTypescript.hash_type,
    args: ForceBridgeCore.config.ckb.ownerCellTypescript.args,
  });
  return ownerTypeHash;
}

export function getMultisigAddr(multisigScript: MultisigItem): string {
  const multisigLockscript = getMultisigLock(multisigScript);
  return encodeToAddress(multisigLockscript);
}
