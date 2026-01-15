import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { User } from './models/User';
import { ChatMessage } from './models/ChatMessage';
import { MYSQL } from './config';

export const AppDataSource = new DataSource({
  type: 'mysql',
  host: MYSQL.host,
  port: MYSQL.port,
  username: MYSQL.user,
  password: MYSQL.password,
  database: MYSQL.database,
  entities: [User, ChatMessage],
  synchronize: true
});
