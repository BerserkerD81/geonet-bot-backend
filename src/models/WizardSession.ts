import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';

export interface WizardStepLog {
  stepName: string;
  stepLabel: string;
  status: 'ok' | 'error' | 'skipped';
  timestamp: string;
  inputData?: Record<string, any>;
  outputData?: Record<string, any>;
  errorMsg?: string;
}

@Entity('wizard_sessions')
export class WizardSession {
  @PrimaryColumn('varchar', { length: 36 })
  id!: string;

  @Index()
  @Column('int')
  userId!: number;

  @Column('varchar', { length: 120, nullable: true })
  userName?: string;

  @Column('varchar', { length: 32 })
  type!: string;

  // in-progress | completed | failed | abandoned
  @Column('varchar', { length: 32, default: 'in-progress' })
  status!: string;

  @Column('int', { nullable: true })
  clientId?: number;

  @Column('varchar', { length: 255, nullable: true })
  clientName?: string;

  @Column('text', { nullable: true })
  stepsJson?: string;

  @Column('text', { nullable: true })
  resumeDataJson?: string;

  @Column('varchar', { length: 500, nullable: true })
  summary?: string;

  @Column('varchar', { length: 500, nullable: true })
  errorMsg?: string;

  @CreateDateColumn()
  startedAt!: Date;

  @Column('datetime', { nullable: true })
  updatedAt?: Date;

  @Column('datetime', { nullable: true })
  completedAt?: Date;

  // Virtual getters/setters — TypeORM won't persist these
  get steps(): WizardStepLog[] {
    try { return this.stepsJson ? JSON.parse(this.stepsJson) : []; } catch { return []; }
  }
  set steps(v: WizardStepLog[]) {
    this.stepsJson = JSON.stringify(v);
  }

  get resumeData(): Record<string, any> | null {
    try { return this.resumeDataJson ? JSON.parse(this.resumeDataJson) : null; } catch { return null; }
  }
  set resumeData(v: Record<string, any> | null) {
    this.resumeDataJson = v ? JSON.stringify(v) : undefined;
  }
}
