export type TransactionType = 'subscription' | 'top_up' | 'one_shot';

export interface TransactionContext {
  userId: string;
  service: string;
  transactionType: TransactionType;
  amountUsd: number;
  description: string;
  idempotencyKey: string;
  agentId?: string; // agent identifier if provided
  projectName?: string;
}
