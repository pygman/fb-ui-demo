import {JSONRPCClient, JSONRPCRequest} from "json-rpc-2.0";
import {ethers} from "ethers";

export class Api {
  client: JSONRPCClient;

  constructor(forceBridgeUrl: string) {
    this.client = new JSONRPCClient((jsonRPCRequest: JSONRPCRequest) =>
      fetch(forceBridgeUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(jsonRPCRequest),
      }).then((response) => {
        if (response.status === 200) {
          // Use client.receive when you received a JSON-RPC response.
          return response.json().then((jsonRPCResponse) => this.client.receive(jsonRPCResponse));
        } else if (jsonRPCRequest.id !== undefined) {
          return Promise.reject(new Error(response.statusText));
        } else {
          return Promise.reject(new Error('request id undefined'));
        }
      }),
    );
  }

  async getBridgeConfig(): Promise<any> {
    return this.client.request('getBridgeConfig');
  }


  async getAssetList(name?: string): Promise<any[]> {
    let param = {asset: name};
    if (name === undefined) {
      param = {asset: 'all'};
    }
    return this.client.request('getAssetList', param);
  }

  async getBalance(payload: any): Promise<any> {
    return this.client.request('getBalance', payload);
  }

  async generateBridgeInNervosTransaction(payload: any): Promise<any> {
    const result = await this.client.request('generateBridgeInNervosTransaction', payload);
    switch (result.network) {
      case 'Ethereum':
      {
        const rawTx = result.rawTransaction;
        rawTx.value = ethers.BigNumber.from(rawTx.value?.hex ?? 0);
        result.rawTransaction = rawTx;
      }
        break;
      default:
        Promise.reject(new Error('not yet'));
    }
    return result;
  }

  async generateBridgeOutNervosTransaction(payload: any): Promise<any> {
    return this.client.request('generateBridgeOutNervosTransaction', payload);
  }

}
