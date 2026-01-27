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

  @Column('varchar', { length: 255, nullable: true })
  imageUrl?: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
