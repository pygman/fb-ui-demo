import CKB from '@nervosnetwork/ckb-sdk-core';

export const ForceBridgeCoreCkb = new CKB(process.env.REACT_APP_CKB_RPC_URL);
