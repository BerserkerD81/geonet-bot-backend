import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, ManyToOne, JoinColumn } from 'typeorm';
import { ChatSession } from './ChatSession'; // Importa la nueva entidad

@Entity()
export class ChatMessage {
  @PrimaryGeneratedColumn('increment')
  id!: number;

  @Index()
  @Column('int')
  userId!: number;

  // --- NUEVOS CAMPOS ---
  @Index()
  @Column('int', { nullable: true }) // Nullable para no romper datos viejos
  sessionId!: number | null;

  @ManyToOne(() => ChatSession, (session) => session.messages, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'sessionId' })
  session!: ChatSession;
  // ---------------------

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

  @Column('datetime', { nullable: true })
  deletedByUserAt?: Date | null;
}