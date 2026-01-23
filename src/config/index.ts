import dotenv from 'dotenv';

dotenv.config();

export const PORT = Number(process.env.PORT) || 3000;
export const NODE_ENV = process.env.NODE_ENV || 'development';
export const SESSION_SECRET = process.env.SESSION_SECRET || 'change_me';
export const MYSQL = {
  host: process.env.MYSQL_HOST || 'mysql',
  port: Number(process.env.MYSQL_PORT) || 3306,
  database: process.env.MYSQL_DATABASE || 'geonet',
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || ''
};
export const VLLM_URL = process.env.VLLM_URL || 'http://localhost:8000';

export const SMTP = {
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || 'no-reply@geonet.local',
  appName: process.env.APP_NAME || 'GeoNet'
};

export const APP_URL = process.env.APP_URL || '';
export const BRAND = {
  primary: process.env.BRAND_PRIMARY || '#0B1C72', // Navy-like
  accent: process.env.BRAND_ACCENT || '#FF8A00', // Orange CTA
  background: '#F6F8FB',
  surface: '#FFFFFF',
  border: '#E5EAF2',
  textPrimary: '#0B1C72',
  textSecondary: '#46526B'
};

export const WISPHUB = {
  baseUrl: process.env.WISPHUB_BASE_URL || 'https://api.wisphub.net',
  apiKey: process.env.WISPHUB_API_KEY || ''
};

export const SMARTOLT = {
  baseUrl: process.env.SMARTOLT_BASE_URL || '',
  apiKey: process.env.SMARTOLT_API_KEY || ''
};
