import { transactionSkeletonToObject } from '@ckb-lumos/helpers';
import React, {useEffect, useMemo, useState} from 'react';
import detectEthereumProvider from '@metamask/detect-provider';
import {MetaMaskInpageProvider} from '@metamask/inpage-provider';
import './App.css';
import {Api} from "./api";
import { helpers, Script, toolkit, core, RPC } from '@ckb-lumos/lumos';
import { SerializeRcLockWitnessLock } from '@ckitjs/rc-lock';
import { JsonRpcSigner } from '@ethersproject/providers/src.ts/json-rpc-provider';
import { ExternalProvider, Web3Provider } from '@ethersproject/providers/src.ts/web3-provider';
import BigNumber from "bignumber.js";
import {ethers} from "ethers";
import ForceBridge from './abi/ForceBridge.json';
import {CkbTxGenerator} from "./ckb/generator";
import {getOwnerTypeHash} from "./ckb/multisig_helper";
import {EthAsset} from "./ckb/model/asset";


function App() {
  let provider: MetaMaskInpageProvider | undefined;
  let signer: JsonRpcSigner | undefined;
  let web3Provider: Web3Provider | undefined;
  let api: Api | undefined;
  const [selectedAddress, setSelectedAddress] = useState<string>('');
  const [bridgeConfig, setBridgeConfig] = useState<any>({});
  const [assetList, setAssetList] = useState<any[]>([]);
  const [xchainBalances, setXchainBalances] = useState<any[]>([]);
  const [nervosBalances, setNervosBalances] = useState<any[]>([]);
  const [bridgeAssetIdent, setBridgeAssetIdent] = useState<string>('0x0000000000000000000000000000000000000000');
  const [bridgeAmount, setBridgeAmount] = useState<string>('');

  const init = async () => {
    console.log('init');
    window.Buffer = window.Buffer || require("buffer").Buffer;
    provider = (await detectEthereumProvider()) as MetaMaskInpageProvider;
    if (!provider) throw new Error('Metamask is required');
    web3Provider = new ethers.providers.Web3Provider(window.ethereum as ExternalProvider);
    signer = web3Provider.getSigner()
    const detectSelectedAddress = () => {
      if (provider!.selectedAddress) {
        setSelectedAddress(provider!.selectedAddress);
      } else {
        setTimeout(detectSelectedAddress, 1000);
      }
    }
    detectSelectedAddress();
    api = new Api(process.env.REACT_APP_BRIDGE_RPC_URL!);
    if (!bridgeConfig.nervos) {
      await handleGetBridgeConfig();
    }
  }

  const selectedCkbAddress = useMemo(() => {
    if (!selectedAddress || !bridgeConfig.nervos) return '';
    const omniLock: Script = {
      code_hash: bridgeConfig.nervos.omniLockCodeHash,
      hash_type: bridgeConfig.nervos.omniLockHashType,
      args: `0x01${selectedAddress.substring(2)}00`,
    };
    return helpers.encodeToAddress(omniLock, {
      config: {PREFIX: 'ckt', SCRIPTS: {}},
    });
  }, [selectedAddress, bridgeConfig]);

  useEffect(() => {
    const timeout = setTimeout(init, 300);
    return () => clearTimeout(timeout);
  })

  const handleWalletConnect = async () => {
    const accounts = await provider!.request?.({method: 'eth_requestAccounts'});
    console.log(`handleWalletConnect ${accounts}`)
    setSelectedAddress((accounts as Array<string>)[0])
    // const ethereum = window.ethereum as ExternalProvider;
    signer = (new ethers.providers.Web3Provider(window.ethereum as ExternalProvider)).getSigner();
  }

  const handleGetBridgeConfig = async () => {
    const bridgeConfig = await api?.getBridgeConfig();
    console.log(JSON.stringify(bridgeConfig));
    setBridgeConfig(bridgeConfig);
  }

  const handleGetAssetList = async () => {
    const assetList = await api?.getAssetList();
    console.log(JSON.stringify(assetList));
    setAssetList(assetList!.filter((asset) => asset.network === 'Ethereum'));
  }

  const handleGetBalance = async () => {
    const xchainBalances = await api?.getBalance(assetList.map((asset) => ({
      network: asset.network,
      assetIdent: asset.ident,
      userIdent: selectedAddress
    })));
    console.log(JSON.stringify(xchainBalances));
    const nervosBalances = await api?.getBalance(assetList.map((asset) => ({
      network: asset.info.shadow.network,
      assetIdent: asset.info.shadow.ident,
      userIdent: selectedCkbAddress
    })));
    console.log(JSON.stringify(xchainBalances));
    console.log(JSON.stringify(nervosBalances));
    setXchainBalances(xchainBalances);
    setNervosBalances(nervosBalances);
  }

  const findBalance = (balances: any[], asset: any) => {
    const balance = balances.find((b) => b.network === 'Ethereum' ? b.ident === asset.ident : b.ident === asset.info.shadow.ident);
    if (!balance) return '';
    return Math.round(balance.amount / 10 ** (asset.info.decimals - 6)) / 10 ** 6;
  }

  const handleToNervos = async () => {
    console.log('handleToNervos');
    const asset = assetList.find((asset) => asset.ident === bridgeAssetIdent);
    if (!asset) return false;
    const amount = BigNumber(bridgeAmount).multipliedBy(BigNumber(10 ** asset.info.decimals)).toString();
    const ckbAddress = window.prompt('transfer to ckb address:', selectedCkbAddress);
    const generated = await api?.generateBridgeInNervosTransaction({
      asset: { network: 'Ethereum', ident: bridgeAssetIdent, amount },
      recipient: ckbAddress,
      sender: selectedAddress,
    });
    console.log(generated);
    const transactionResponse = await signer!.sendTransaction(generated.rawTransaction);
    console.log(transactionResponse);
    alert(`success: ${transactionResponse.hash}`)
  }

  const handleToEthereum = async () => {
    console.log('handleToEthereum');
    const asset = assetList.find((asset) => asset.ident === bridgeAssetIdent);
    if (!asset) return false;
    const amount = BigNumber(bridgeAmount).multipliedBy(BigNumber(10 ** asset.info.decimals)).toString();
    const ethAddress = window.prompt('transfer eth address:', selectedAddress);

    const generated = await api?.generateBridgeOutNervosTransaction({
      network: 'Ethereum',
      amount,
      asset: bridgeAssetIdent,
      recipient: ethAddress,
      sender: selectedCkbAddress,
    });
    console.log(generated);

    let skeleton = helpers.objectToTransactionSkeleton(generated.rawTransaction);
    const messageToSign = skeleton.signingEntries.get(0)?.message;
    if (!messageToSign) throw new Error('Invalid burn tx: no signingEntries');
    if (!window.ethereum) throw new Error('Could not find ethereum wallet');
    const paramsToSign = (window.ethereum as any).isSafePal ? [messageToSign] : [selectedAddress, messageToSign];
    let sigs = await web3Provider!.send('personal_sign', paramsToSign);

    let v = Number.parseInt(sigs.slice(-2), 16);
    if (v >= 27) v -= 27;
    sigs = '0x' + sigs.slice(2, -2) + v.toString(16).padStart(2, '0');

    const signedWitness = new toolkit.Reader(
      core.SerializeWitnessArgs({
        lock: SerializeRcLockWitnessLock({
          signature: new toolkit.Reader(sigs),
        }),
      }),
    ).serializeJson();

    skeleton = skeleton.update('witnesses', (witnesses) => witnesses.push(signedWitness));

    const signedTx = helpers.createTransactionFromSkeleton(skeleton);
    console.log(signedTx);
    const txHash = await new RPC(process.env.REACT_APP_CKB_RPC_URL!).send_transaction(signedTx, 'passthrough');

    alert(`success: ${txHash}`)
  }

  function stringToUint8Array(str: string): Uint8Array {
    const arr: number[] = [];
    for (let i = 0, j = str.length; i < j; ++i) {
      arr.push(str.charCodeAt(i));
    }
    return new Uint8Array(arr);
  }

  const handleToNervosFrontend = async () => {
    console.log('handleToNervosFrontend');
    const asset = assetList.find((asset) => asset.ident === bridgeAssetIdent);
    if (!asset) return false;
    const amount = BigNumber(bridgeAmount).multipliedBy(BigNumber(10 ** asset.info.decimals)).toString();
    const ckbAddress = window.prompt('transfer to ckb address:', selectedCkbAddress);
    const sudtExtraData = '0x';
    console.log(process.env.REACT_APP_BRIDGE_CONTRACT_ADDR);
    const bridgeContract = new ethers.Contract(process.env.REACT_APP_BRIDGE_CONTRACT_ADDR!, ForceBridge.abi, signer);
    const ethAmount = ethers.utils.parseUnits(amount, 0);
    const recipient = stringToUint8Array(ckbAddress!);
    const resp = bridgeAssetIdent === '0x0000000000000000000000000000000000000000' ?
      await bridgeContract.lockETH(recipient, sudtExtraData, {
        value: ethAmount,
      }) :
      await bridgeContract.lockToken(
        bridgeAssetIdent,
        ethAmount,
        recipient,
        sudtExtraData,
      )
    console.log(resp);
    alert(`success: ${resp.hash}`)
  }

  const handleToEthereumFrontend = async () => {
    console.log('handleToEthereumFrontend');
    const asset = assetList.find((asset) => asset.ident === bridgeAssetIdent);
    if (!asset) return false;
    const amount = BigNumber(bridgeAmount).multipliedBy(BigNumber(10 ** asset.info.decimals)).toString();
    const ethAddress = window.prompt('transfer eth address:', selectedAddress);

    // TODO
    const fromLockscript = helpers.parseAddress(selectedCkbAddress, {
      config: {PREFIX: 'ckt', SCRIPTS: {}},
    });
    const ownerTypeHash = getOwnerTypeHash();
    const ethAsset = new EthAsset(bridgeAssetIdent, ownerTypeHash);
    const ckbTxGenerator = new CkbTxGenerator(
      process.env.REACT_APP_CKB_RPC_URL!,
      process.env.REACT_APP_CKB_INDEXER_URL!,
    );

    const burnTxSkeleton = await ckbTxGenerator.burn(fromLockscript, ethAddress!, ethAsset, BigInt(amount))
    const rawTransaction = transactionSkeletonToObject(burnTxSkeleton);
    console.log(rawTransaction);

    let skeleton = helpers.objectToTransactionSkeleton(rawTransaction);
    const messageToSign = skeleton.signingEntries.get(0)?.message;
    if (!messageToSign) throw new Error('Invalid burn tx: no signingEntries');
    if (!window.ethereum) throw new Error('Could not find ethereum wallet');
    const paramsToSign = (window.ethereum as any).isSafePal ? [messageToSign] : [selectedAddress, messageToSign];
    let sigs = await web3Provider!.send('personal_sign', paramsToSign);

    let v = Number.parseInt(sigs.slice(-2), 16);
    if (v >= 27) v -= 27;
    sigs = '0x' + sigs.slice(2, -2) + v.toString(16).padStart(2, '0');

    const signedWitness = new toolkit.Reader(
      core.SerializeWitnessArgs({
        lock: SerializeRcLockWitnessLock({
          signature: new toolkit.Reader(sigs),
        }),
      }),
    ).serializeJson();

    skeleton = skeleton.update('witnesses', (witnesses) => witnesses.push(signedWitness));

    const signedTx = helpers.createTransactionFromSkeleton(skeleton);
    console.log(signedTx);
    const txHash = await new RPC(process.env.REACT_APP_CKB_RPC_URL!).send_transaction(signedTx, 'passthrough');

    alert(`success: ${txHash}`)
  }

  return (
    <div className="App">
      <header className="App-header">
        <div style={{position: "absolute", left: "2rem", top: "2rem"}}>
          <a className="Header-link " href="https://github.com/pygman/fb-ui-demo" data-hotkey="g d" aria-label="Homepage "
             data-turbo="false"
             data-analytics-event="{&quot;category&quot;:&quot;Header&quot;,&quot;action&quot;:&quot;go to dashboard&quot;,&quot;label&quot;:&quot;icon:logo&quot;}">
            <svg height="32" aria-hidden="true" viewBox="0 0 16 16" version="1.1" width="32" data-view-component="true"
                 className="octicon octicon-mark-github v-align-middle">
              <path fill-rule="evenodd"
                    d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
            </svg>
          </a>
        </div>
        <div>
          <div className="row">
            <div>Ethereum</div>
            <div className="address"><input type="text" value={selectedAddress}/></div>
            <div>-&gt;</div>
            <div>---</div>
            <div>&lt;-</div>
            <div className="address"><input type="text" value={selectedCkbAddress}/></div>
            <div>Nervos</div>
          </div>
        </div>
        <div>
          {
            assetList && assetList.map((asset) =>
              <div key={asset.info.symbol} className="row">
                <div className="amount">{findBalance(xchainBalances, asset)}</div>
                <div>{asset.info.symbol}</div>
                <div>-&gt;</div>
                <div>---</div>
                <div>&lt;-</div>
                <div>{asset.info.symbol} | eth</div>
                <div className="amount">{findBalance(nervosBalances, asset)}</div>
              </div>
            )
          }
        </div>
        <div style={{border: "burlywood", borderStyle: "outset"}}>
          <div className="row">
            <div>
              <select value={bridgeAssetIdent} onChange={event => setBridgeAssetIdent(event.target.value)}>
                {
                  assetList && assetList.map((asset) =>
                    <option value={asset.ident}>{asset.info.symbol}</option>)
                }
              </select>
            </div>
            <div>
              <input type="text" value={bridgeAmount} onChange={event => {
                const amount = event.target.value;
                if (/^[0-9]*([0-9]\.)?[0-9]*$/.test(amount)) {
                  setBridgeAmount(amount);
                }
              }}/>
            </div>
            <div>
              <button onClick={handleToNervos}>from ethereum to nervos -&gt;</button>
              <button onClick={handleToNervosFrontend}>from ethereum to nervos(frontend) -&gt;</button>
            </div>
            <div>---</div>
            <div>
              <button onClick={handleToEthereum}>&lt;- from nervos to ethereum</button>
              <button onClick={handleToEthereumFrontend}>&lt;- from nervos to ethereum(frontend)</button>
            </div>
            <div></div>
            <div></div>
          </div>
        </div>
      </header>
      <div className="App-body">
        {
          selectedAddress ?
            <button>{selectedAddress}</button> :
            <button onClick={handleWalletConnect}>0. Connect a Wallet To Start</button>
        }
        <button onClick={handleGetBridgeConfig}>1. getBridgeConfig</button>
        <button onClick={handleGetAssetList}>2. getAssetList</button>
        <button onClick={handleGetBalance}>3. getBalance</button>
      </div>
    </div>
  );
}

export default App;
