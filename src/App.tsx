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

  return (
    <div className="App">
      <header className="App-header">
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
            </div>
            <div>---</div>
            <div>
              <button onClick={handleToEthereum}>&lt;- from nervos to ethereum</button>
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
