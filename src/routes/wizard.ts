import express from 'express';
import { requireAuth } from '../middlewares/auth';
import {
  getAuthWizardInstallations, prepareAuthWizard, getOdbsByZone, applyWifiWizard, activateWispHubWizard,
  activateTr069Wizard, getVlansWizard, getWifiTaskStatus, getOnuSignalWizard,
  searchChangeOnuClients, prepareChangeOnuWizard, submitChangeOnuWizard,
  prepareMonitorWizard, rebootMonitorWizard, resyncMonitorWizard,
  submitBajaWizard, uploadFotoWizard, getIptvDevices, linkIptvDevices, unlinkIptvDevices,
} from '../controllers/wizardController';
import {
  createWizardSession, logWizardStep, updateWizardResumeData,
  completeWizardSession, failWizardSession, abandonWizardSession,
  listWizardSessions, searchWizardSessions, getWizardSession,
} from '../controllers/wizardSessionController';

const router = express.Router();

// Auth wizard
router.get('/auth/installations', requireAuth, getAuthWizardInstallations);
router.post('/auth/prepare', requireAuth, prepareAuthWizard);
router.get('/auth/odbs', requireAuth, getOdbsByZone);
router.get('/auth/vlans', requireAuth, getVlansWizard);
router.post('/auth/wifi', requireAuth, applyWifiWizard);
router.get('/auth/wifi/task-status', requireAuth, getWifiTaskStatus);
router.get('/signal', requireAuth, getOnuSignalWizard);
router.post('/auth/activate', requireAuth, activateWispHubWizard);
router.post('/auth/tr069', requireAuth, activateTr069Wizard);

// Change ONU wizard
router.post('/change-onu/search', requireAuth, searchChangeOnuClients);
router.post('/change-onu/prepare', requireAuth, prepareChangeOnuWizard);
router.post('/change-onu/submit', requireAuth, submitChangeOnuWizard);

// Monitor wizard
router.post('/monitor/prepare', requireAuth, prepareMonitorWizard);
router.post('/monitor/reboot', requireAuth, rebootMonitorWizard);
router.post('/monitor/resync', requireAuth, resyncMonitorWizard);

// Baja cliente wizard
router.post('/baja/submit', requireAuth, submitBajaWizard);

// Fotos wizard
router.post('/fotos/upload', requireAuth, uploadFotoWizard);

// IPTV wizard
router.get('/iptv/devices', requireAuth, getIptvDevices);
router.post('/iptv/link', requireAuth, linkIptvDevices);
router.post('/iptv/unlink', requireAuth, unlinkIptvDevices);

// Wizard sessions (historial)
router.post('/sessions', requireAuth, createWizardSession);
router.get('/sessions/search', requireAuth, searchWizardSessions);
router.patch('/sessions/:id/step', requireAuth, logWizardStep);
router.patch('/sessions/:id/resume-data', requireAuth, updateWizardResumeData);
router.patch('/sessions/:id/complete', requireAuth, completeWizardSession);
router.patch('/sessions/:id/fail', requireAuth, failWizardSession);
router.post('/sessions/:id/abandon', requireAuth, abandonWizardSession);
router.get('/sessions', requireAuth, listWizardSessions);
router.get('/sessions/:id', requireAuth, getWizardSession);

export default router;
