import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity()
export class ChatMessage {
  @PrimaryGeneratedColumn('increment')
  id!: number;

  @Index()
  @Column('int')
  userId!: number;

  @Column('varchar', { length: 16 })
  role!: 'user' | 'assistant';

  @Column('text')
  content!: string;

  @Column('simple-json', { nullable: true })
  actions?: Array<{
    id: string;
    type: 'button' | 'input';
    label: string;
    payload?: string;
    placeholder?: string;
    helperText?: string;
  }> | null;

  @Column('simple-json', { nullable: true })
  metadata?: Record<string, any> | null;

  @Column('varchar', { length: 255, nullable: true })
  imageUrl?: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
