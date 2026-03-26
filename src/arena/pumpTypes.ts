// PumpToken type — self-contained (no dependency on SHLL project)
export interface PumpToken {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  traderPublicKey: string;
  initialBuy: number;
  marketCapSol: number;
  timestamp: number;
  bondingCurveKey?: string;
  vTokensInBondingCurve?: number;
  vSolInBondingCurve?: number;
}
