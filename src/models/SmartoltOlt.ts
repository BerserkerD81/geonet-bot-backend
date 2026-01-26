import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SmartoltVlan } from './SmartoltVlan';

@Entity('smartolt_olt')
export class SmartoltOlt {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 255, unique: true, nullable: true })
  externalId?: string | null;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'datetime' })
  collectedAt!: Date;

  @OneToMany(() => SmartoltVlan, (v) => v.olt)
  vlans!: SmartoltVlan[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
