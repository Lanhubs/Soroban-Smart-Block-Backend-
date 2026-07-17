declare namespace Express {
  interface Request {
    body: any;
    coldStorage?: {
      enabled: boolean;
      type: string;
      path?: string;
      ledgerSeq: number;
    };
    network: import('../profiles').NetworkName;
    networkProfile: import('../profiles').NetworkProfile;
    user?: {
      id: string;
      address: string;
      role: string;
      tier: string;
      sessionId: string;
      appId?: string;
    };
  }
}
