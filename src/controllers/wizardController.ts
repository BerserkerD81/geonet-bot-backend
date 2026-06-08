import fs from 'fs';
import path from 'path';
import { AppDataSource } from '../datasource';
import { Installation } from '../models/Installation';
import { Client } from '../models/Client';
import { SmartoltOdb } from '../models/SmartoltOdb';
import { SmartoltOnuDetail } from '../models/SmartoltOnuDetail';
import { listAllLocalInstallations, fullSyncInstallations } from '../services/wisphubInstallations';
import { prepareAuthSession, buildAuthActions, resolveIsPyme, resolveGeonetInstallationUser, loadMonitorSmartoltData, classifyOnuSignalQuality } from './chatController';
import {
  getOdbs, getInternalOnuIdBySn, updateOnuWifi, getAllOnuTypes,
  listGlobalUnconfiguredOnus, changeOnuType, updateOnuSn,
  rebootOnuByExternalId, resyncOnuConfigByExternalId,
} from '../services/smartoltClient';
import {
  activarInstalacionGeonet, processContractUpdate, getAutoLoginContractLink,
  refreshClientsByTerm, fullSyncClients, replaceOnuForClient,
  deleteWifiProductByName, darDeBajaClienteByServiceId, uploadDocumentoCliente,
} from '../services/wisphubClient';

// GET /wizard/auth/odbs?zone=Batallas
export async function getOdbsByZone(req: any, res: any) {
  const zone: string = (req.query.zone as string) || '';
  try {
    const odbRepo = AppDataSource.getRepository(SmartoltOdb);
    let qb = odbRepo.createQueryBuilder('odb')
      .leftJoinAndSelect('odb.zone', 'zone')
      .orderBy('zone.name', 'ASC')
      .addOrderBy('odb.name', 'ASC');

    if (zone) {
      qb = qb.where('LOWER(zone.name) LIKE :zf', { zf: `%${zone.toLowerCase()}%` });
    }

    const rows = await qb.getMany();
    let odbs = rows.map(o => ({ id: o.externalId || String(o.id), name: o.name || '', zone: o.zone?.name || '' })).filter(o => o.name);

    // Fallback to SmartOLT API if DB has nothing
    if (!odbs.length) {
      const apiOdbs = await getOdbs().catch(() => []);
      const all = (apiOdbs as any[]).map(o => ({ id: String(o.id || o.name), name: String(o.name || o.id), zone: String(o.zone_name || o.zone || '') })).filter(o => o.name);
      odbs = zone ? all.filter(o => o.zone.toLowerCase().includes(zone.toLowerCase()) || o.name.toLowerCase().includes(zone.toLowerCase())) : all;
    }

    return res.json({ ok: true, odbs });
  } catch (e: any) {
    console.error('[wizard] getOdbsByZone error:', e);
    return res.status(500).json({ ok: false, error: e.message, odbs: [] });
  }
}

// GET /wizard/auth/installations
export async function getAuthWizardInstallations(req: any, res: any) {
  try {
    let items = await listAllLocalInstallations(0);
    if (!items.length) {
      await fullSyncInstallations(100, 3).catch(() => {});
      items = await listAllLocalInstallations(0);
    }
    const results = items.map(i => ({
      id: i.id,
      id_servicio: i.id_servicio,
      nombre: i.nombre,
      apellidos: i.apellidos,
      cedula: i.cedula,
      servicio: i.servicio,
      plan_internet: i.plan_internet,
      zona: i.zona,
      direccion: i.direccion,
      estado_instalacion: i.estado_instalacion,
      estado: i.estado,
      sn_onu: i.sn_onu,
      usuario: i.usuario,
      fecha_instalacion: i.fecha_instalacion,
    }));
    return res.json({ ok: true, results });
  } catch (e: any) {
    console.error('[wizard] getAuthWizardInstallations error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// POST /wizard/auth/prepare  body: { installationId }
export async function prepareAuthWizard(req: any, res: any) {
  const session = req.session || {};
  const userId = session.userId;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const { installationId } = req.body;
  if (!installationId) return res.status(400).json({ error: 'installationId required' });

  try {
    const repo = AppDataSource.getRepository(Installation);
    const installation = await repo.findOne({ where: { id: Number(installationId) } });
    if (!installation) return res.status(404).json({ error: 'installation_not_found' });

    // Set session vars the same way the chat flow does when a client is selected
    session.lastSelectedClientIdServicio = installation.id_servicio;
    session.lastSelectedInstallationId = installation.id;
    session.lastSelectedUsuarioInstalacion = installation.usuario || undefined;
    if (installation.plan_internet) {
      session.lastSelectedPlan = installation.plan_internet;
    }

    const { text, actions, assistantMetadata } = await prepareAuthSession(session, installation, 'installation');

    // Build current form state with pre-filled options
    const formActions = await buildAuthActions(session.pendingAuth, req);

    // Extract structured options from form actions for the wizard UI
    const options: Record<string, string[]> = {};
    for (const a of formActions) {
      if (a.options?.length) options[a.id] = a.options;
    }

    // Extract unconfigured ONUs list from smartolt availability
    const unconfiguredOnus: any[] = [];
    const oltAvailability = (assistantMetadata?.smartoltAvailability as any)?.olts || [];
    for (const olt of oltAvailability) {
      for (const onu of olt.onus || []) {
        unconfiguredOnus.push({
          sn: onu.id,
          oltId: olt.oltId,
          oltName: olt.oltName,
          ponType: onu.ponType,
          port: onu.port,
          model: onu.model,
        });
      }
    }

    const defaults = session.pendingAuth?.defaults || {};
    const collected = session.pendingAuth?.collected || {};

    // Pass full ODB objects (id + name) so the wizard can call the ports endpoint
    const odbObjects: Array<{ id: string; name: string }> = ((session.pendingAuth?.smartoltOdbs || []) as any[])
      .filter(o => o.id || o.name)
      .map(o => ({ id: String(o.id || o.name), name: String(o.name || o.id) }));

    return res.json({
      ok: true,
      defaults,
      collected,
      options,
      unconfiguredOnus,
      oltAvailability,
      odbObjects,
      text,
    });
  } catch (e: any) {
    console.error('[wizard] prepareAuthWizard error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// POST /wizard/auth/wifi  body: { sn, ssid, pass }
export async function applyWifiWizard(req: any, res: any) {
  const session = req.session || {};
  if (!session.userId) return res.status(401).json({ error: 'unauthenticated' });

  const { sn, ssid, pass } = req.body;
  if (!sn || !ssid || !pass) return res.status(400).json({ error: 'sn, ssid y pass son requeridos' });

  try {
    const internalId = await getInternalOnuIdBySn(String(sn).toUpperCase());
    if (!internalId) return res.status(404).json({ ok: false, error: `No se encontró ID interno para SN ${sn}` });

    const results: string[] = [];
    try {
      await updateOnuWifi(internalId, '2.4GHz', ssid, pass, true);
      results.push('✅ 2.4GHz configurado');
    } catch (e: any) {
      results.push(`❌ 2.4GHz: ${e.message}`);
    }
    try {
      await updateOnuWifi(internalId, '5GHz', `${ssid}_5G`, pass, true);
      results.push('✅ 5GHz configurado');
    } catch (e: any) {
      results.push(`⚠️ 5GHz: ${e.message || 'No disponible'}`);
    }

    const allFailed = results.every(r => r.startsWith('❌'));
    return res.json({ ok: !allFailed, results, ssid, pass });
  } catch (e: any) {
    console.error('[wizard] applyWifiWizard error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// POST /wizard/auth/activate  body: { targetId }
export async function activateWispHubWizard(req: any, res: any) {
  const session = req.session || {};
  if (!session.userId) return res.status(401).json({ error: 'unauthenticated' });

  const { targetId } = req.body;
  if (!targetId) return res.status(400).json({ error: 'targetId requerido' });

  try {
    const isPyme = await resolveIsPyme(session, targetId);
    const { fullUser } = await resolveGeonetInstallationUser(targetId, session);

    let contractUrl: string | null = null;
    let contractError: string | null = null;

    if (!isPyme) {
      try {
        await processContractUpdate(targetId);
        contractUrl = await getAutoLoginContractLink(fullUser, targetId);
      } catch (e: any) {
        contractError = e.message;
        console.error('[wizard] contract error:', e);
      }
    }

    // Activate with retry (up to 3 attempts)
    let activated = false;
    let activationMsg = '';
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const actRes = await activarInstalacionGeonet(targetId, fullUser);
        if (actRes?.ok) { activated = true; activationMsg = actRes.status === 202 ? 'pendiente' : 'exitosa'; break; }
        if (actRes?.status === 429) { await sleep(3000 * attempt); continue; }
        activationMsg = actRes?.error || `status ${actRes?.status}`;
        break;
      } catch (e: any) {
        activationMsg = e.message;
        if (attempt < 3) await sleep(2000);
      }
    }

    return res.json({
      ok: activated,
      activated,
      activationMsg,
      isPyme,
      usuario: fullUser,
      contractUrl: contractUrl || null,
      contractError: contractError || null,
    });
  } catch (e: any) {
    console.error('[wizard] activateWispHubWizard error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ---------------------------------------------------------------------------
// CAMBIO DE ONU WIZARD
// ---------------------------------------------------------------------------

// POST /wizard/change-onu/search  body: { nombre?, rut? }
export async function searchChangeOnuClients(req: any, res: any) {
  const session = req.session || {};
  if (!session.userId) return res.status(401).json({ error: 'unauthenticated' });

  const { nombre, rut } = req.body || {};
  const nameTerm = String(nombre || '').trim();
  const rutTerm = String(rut || '').trim();

  if (!nameTerm && !rutTerm) return res.status(400).json({ error: 'nombre o rut requerido' });

  try {
    const repo = AppDataSource.getRepository(Client);
    const qb = repo.createQueryBuilder('c');

    if (rutTerm) {
      const cleanedRut = rutTerm.replace(/[\.\-\s]+/g, '');
      qb.andWhere(
        '(c.cedula = :rutExact OR LOWER(c.cedula) LIKE LOWER(:rutLike) OR REPLACE(REPLACE(REPLACE(LOWER(c.cedula), ".", ""), "-", ""), " ", "") LIKE LOWER(:cleanedRut))',
        { rutExact: rutTerm, rutLike: `%${rutTerm}%`, cleanedRut: `%${cleanedRut}%` }
      );
    }
    if (nameTerm) {
      const tokens = nameTerm.split(/\s+/).filter(Boolean);
      tokens.forEach((t, idx) => {
        qb.andWhere(`(LOWER(c.nombre) LIKE LOWER(:t${idx}) OR LOWER(c.apellidos) LIKE LOWER(:t${idx}))`, {
          [`t${idx}`]: `%${t}%`,
        });
      });
    }

    let clients = await qb.orderBy('c.id_servicio', 'DESC').take(10).getMany();

    // Sync fallback if empty
    if (!clients.length) {
      const syncTerm = rutTerm || nameTerm;
      await refreshClientsByTerm(syncTerm).catch(() => 0);
      clients = await qb.getMany();
    }
    if (!clients.length) {
      await fullSyncClients().catch(() => {});
      clients = await qb.getMany();
    }

    const results = clients.map(c => ({
      id_servicio: c.id_servicio,
      nombre: c.nombre,
      apellidos: c.apellidos,
      cedula: c.cedula,
      servicio: c.servicio,
      plan_internet: c.plan_internet,
      ip: c.ip,
      estado: c.estado,
      usuario: c.usuario,
    }));

    return res.json({ ok: true, clients: results });
  } catch (e: any) {
    console.error('[wizard] searchChangeOnuClients error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// POST /wizard/change-onu/prepare  body: { clientId }
export async function prepareChangeOnuWizard(req: any, res: any) {
  const session = req.session || {};
  if (!session.userId) return res.status(401).json({ error: 'unauthenticated' });

  const { clientId } = req.body || {};
  if (!clientId) return res.status(400).json({ error: 'clientId requerido' });

  try {
    const clientRepo = AppDataSource.getRepository(Client);
    const client = await clientRepo.findOne({ where: { id_servicio: Number(clientId) } });
    if (!client) return res.status(404).json({ ok: false, error: 'Cliente no encontrado' });

    // Look up current ONU by IP in SmartoltOnuDetail
    let currentOnu: { sn: string; model: string; externalId: string } | null = null;
    if (client.ip) {
      try {
        const detailRepo = AppDataSource.getRepository(SmartoltOnuDetail);
        const detail = await detailRepo
          .createQueryBuilder('o')
          .where('o.ipAddress = :ip', { ip: client.ip })
          .orderBy('o.capturedAt', 'DESC')
          .limit(1)
          .getOne();

        if (detail) {
          const p = detail.payload || {};
          const externalId = String(
            detail.uniqueExternalId ||
            p.onu_external_id || p.unique_external_id || p.external_id || p.onu_id || p.id || ''
          );
          const sn = String(detail.sn || p.sn || p.serial || p.onu_sn || '');
          const model = String(p.onu_type || p.model || p.onu_type_name || '');
          if (externalId || sn) currentOnu = { sn, model, externalId };
        }
      } catch (e) {
        console.warn('[wizard] ONU lookup failed:', e);
      }
    }

    // Get unconfigured ONUs and ONU types in parallel
    const [unconfiguredRaw, onuTypes] = await Promise.all([
      listGlobalUnconfiguredOnus({ cacheTtlMs: 60000 }).catch(() => []),
      getAllOnuTypes().catch(() => [] as string[]),
    ]);

    const unconfiguredOnus = (unconfiguredRaw as any[]).map(o => ({
      sn: String(o.sn || o.serial || ''),
      oltId: String(o.olt_id || o.oltId || ''),
      oltName: String(o.olt_name || o.oltName || ''),
      ponType: String(o.pon_type || o.ponType || 'gpon'),
      port: String(o.port || ''),
      model: String(o.onu_type || o.model || o.onu_type_name || ''),
    })).filter(o => o.sn);

    return res.json({
      ok: true,
      client: {
        id_servicio: client.id_servicio,
        nombre: client.nombre,
        apellidos: client.apellidos,
        cedula: client.cedula,
        servicio: client.servicio,
        plan_internet: client.plan_internet,
        ip: client.ip,
        usuario: client.usuario,
      },
      currentOnu,
      unconfiguredOnus,
      onuTypes,
    });
  } catch (e: any) {
    console.error('[wizard] prepareChangeOnuWizard error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// POST /wizard/change-onu/submit  body: { clientId, onuExternalId, oldSn, oldModel, newSn, newModel }
export async function submitChangeOnuWizard(req: any, res: any) {
  const session = req.session || {};
  if (!session.userId) return res.status(401).json({ error: 'unauthenticated' });

  const { clientId, onuExternalId, oldSn, oldModel, newSn, newModel } = req.body || {};
  if (!clientId || !onuExternalId || !newSn || !newModel) {
    return res.status(400).json({ error: 'clientId, onuExternalId, newSn y newModel son requeridos' });
  }

  try {
    const onuTypes: string[] = await getAllOnuTypes().catch(() => []);
    const newModelText = String(newModel).trim();
    const resolvedModel = onuTypes.find(t => t.toUpperCase().replace(/[- ]/g, '') === newModelText.toUpperCase().replace(/[- ]/g, '')) || newModelText;

    const results: string[] = [];

    // 1. Change ONU type in SmartOLT (skip if same model)
    const normalizedOld = String(oldModel || '').toUpperCase().replace(/[- ]/g, '');
    const normalizedNew = resolvedModel.toUpperCase().replace(/[- ]/g, '');
    let typeUpdated = false;

    if (normalizedOld && normalizedOld === normalizedNew) {
      results.push(`ℹ️ Modelo igual (${resolvedModel}), sin cambio de tipo.`);
      typeUpdated = true;
    } else {
      try {
        await changeOnuType(String(onuExternalId), resolvedModel);
        results.push(`✅ Tipo ONU actualizado a ${resolvedModel}`);
        typeUpdated = true;
      } catch (e: any) {
        results.push(`❌ Error cambiando modelo: ${e?.message || 'falló'}`);
      }
    }

    // 2. Update SN in SmartOLT
    if (typeUpdated) {
      try {
        await updateOnuSn(String(onuExternalId), String(newSn));
        results.push(`✅ SN actualizado a ${newSn}`);
      } catch (e: any) {
        results.push(`❌ Error actualizando SN: ${e?.message || 'falló'}`);
      }
    } else {
      results.push('⚠️ SN no actualizado porque el cambio de modelo falló.');
    }

    // 3. Replace ONU in Geonet/WispHub
    const clientRepo = AppDataSource.getRepository(Client);
    const client = await clientRepo.findOne({ where: { id_servicio: Number(clientId) } });
    const clienteUsuario = client?.usuario || `${Number(clientId)}@geonet`;
    const oldSerialToUse = String(oldSn || newSn);

    try {
      const replaced = await replaceOnuForClient(
        Number(clientId), clienteUsuario, oldSerialToUse, resolvedModel, String(newSn), ''
      );
      results.push(replaced ? '✅ Reemplazo en Geonet completado' : '⚠️ Reemplazo en Geonet falló');
    } catch (e: any) {
      results.push(`❌ Error en Geonet: ${e?.message || 'excepción'}`);
    }

    const wifiRequired = ['ZTEF6600P', 'ZXHNF600P'].includes(normalizedNew);

    return res.json({
      ok: true,
      results,
      wifiRequired,
      newSn: String(newSn),
      newModel: resolvedModel,
      onuExternalId,
    });
  } catch (e: any) {
    console.error('[wizard] submitChangeOnuWizard error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// POST /wizard/monitor/prepare
// Body: { clientId: number, graphType?: string }
export async function prepareMonitorWizard(req: any, res: any) {
  const { clientId, graphType = 'daily' } = req.body || {};
  try {
    if (!clientId) return res.status(400).json({ ok: false, error: 'clientId requerido' });

    const clientRepo = AppDataSource.getRepository(Client);
    const client = await clientRepo.findOne({ where: { id_servicio: Number(clientId) } });
    if (!client) return res.status(404).json({ ok: false, error: 'Cliente no encontrado' });

    const clientInfo = {
      id: client.id_servicio,
      name: client.nombre,
      rut: client.cedula,
      ip: client.ip,
      plan: client.plan_internet || client.precio_plan,
    };

    // Resolve ONU detail from DB snapshot (same logic as prepareChangeOnuWizard)
    let resolvedOnu: { sn: string; model: string; externalId: string } | null = null;
    if (client.ip) {
      try {
        const onuRepo = AppDataSource.getRepository(SmartoltOnuDetail);
        const detail = await onuRepo
          .createQueryBuilder('o')
          .where('o.ipAddress = :ip', { ip: client.ip })
          .orderBy('o.capturedAt', 'DESC')
          .limit(1)
          .getOne();

        if (detail) {
          const p = detail.payload || {};
          const externalId = String(
            detail.uniqueExternalId ||
            p.onu_external_id || p.unique_external_id || p.external_id || p.onu_id || p.id || ''
          );
          const sn = String(detail.sn || p.sn || p.serial || p.onu_sn || '');
          const model = String(p.onu_type || p.model || p.onu_type_name || '');
          if (externalId || sn) resolvedOnu = { sn, model, externalId };
        }
      } catch (e) {
        console.warn('[wizard] ONU lookup failed for monitor:', e);
      }
    }

    if (!resolvedOnu?.externalId) {
      return res.json({
        ok: true,
        client: clientInfo,
        onuDetail: resolvedOnu,
        monitor: null,
        quality: null,
      });
    }

    const monitor = await loadMonitorSmartoltData(resolvedOnu.externalId, graphType as any);
    const quality = classifyOnuSignalQuality({
      signal1490: monitor.signal1490,
      signalValue: monitor.signalValue,
      rx: monitor.rx,
      statusSummary: monitor.statusSummary,
    });

    return res.json({
      ok: true,
      client: clientInfo,
      onuDetail: resolvedOnu,
      monitor: {
        statusSummary: monitor.statusSummary,
        rx: monitor.rx,
        tx: monitor.tx,
        signal1490: monitor.signal1490,
        signal1310: monitor.signal1310,
        signalValue: monitor.signalValue,
        onlineUptime: monitor.onlineUptime,
        distanceOltOnu: monitor.distanceOltOnu,
        runningConfig: monitor.runningConfig,
        graphType: monitor.graphType,
        signalGraphUrl: monitor.signalGraphUrl,
        trafficGraphUrl: monitor.trafficGraphUrl,
        failedApis: monitor.failedApis,
      },
      quality,
    });
  } catch (e: any) {
    console.error('[wizard] prepareMonitorWizard error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// POST /wizard/monitor/reboot
// Body: { onuExternalId: string }
export async function rebootMonitorWizard(req: any, res: any) {
  const { onuExternalId } = req.body || {};
  try {
    if (!onuExternalId) return res.status(400).json({ ok: false, error: 'onuExternalId requerido' });
    const result = await rebootOnuByExternalId(String(onuExternalId));
    return res.json({ ok: true, result });
  } catch (e: any) {
    console.error('[wizard] rebootMonitorWizard error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// POST /wizard/monitor/resync
// Body: { onuExternalId: string }
export async function resyncMonitorWizard(req: any, res: any) {
  const { onuExternalId } = req.body || {};
  try {
    if (!onuExternalId) return res.status(400).json({ ok: false, error: 'onuExternalId requerido' });
    const result = await resyncOnuConfigByExternalId(String(onuExternalId));
    return res.json({ ok: true, result });
  } catch (e: any) {
    console.error('[wizard] resyncMonitorWizard error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// POST /wizard/baja/submit
// Body: { clientId: number }
// Executes: deleteWifiProductByName → darDeBajaClienteByServiceId
// Returns step-by-step results so the UI can show exactly what happened.
const BAJA_CONTINUE_ERRORS = new Set([
  'product_not_found',
  'delete_button_not_found',
  'confirmation_button_not_found',
  'product_still_exists',
  'product_serial_not_found',
  'smartolt_sn_not_found_for_client_ip',
  'smartolt_delete_failed',
]);

export async function submitBajaWizard(req: any, res: any) {
  const { clientId } = req.body || {};
  try {
    if (!clientId) return res.status(400).json({ ok: false, error: 'clientId requerido' });

    const clientRepo = AppDataSource.getRepository(Client);
    const client = await clientRepo.findOne({ where: { id_servicio: Number(clientId) } });
    if (!client) return res.status(404).json({ ok: false, error: 'Cliente no encontrado' });

    const searchTerm = client.usuario || client.nombre || `${client.nombre || ''} ${client.apellidos || ''}`.trim();
    const steps: { step: string; ok: boolean; msg: string }[] = [];

    // Step 1: delete WiFi product
    let continueWithBaja = false;
    try {
      const deleteResult = await deleteWifiProductByName(searchTerm);
      if (deleteResult.ok && deleteResult.deleted) {
        steps.push({ step: 'wifi', ok: true, msg: `✅ Producto WiFi eliminado${deleteResult.note ? ` — ${deleteResult.note}` : ''}` });
        continueWithBaja = true;
      } else if (deleteResult.error && BAJA_CONTINUE_ERRORS.has(deleteResult.error)) {
        steps.push({ step: 'wifi', ok: false, msg: `⚠️ Producto WiFi no eliminado (${deleteResult.error}) — se continúa con la baja` });
        continueWithBaja = true;
      } else {
        steps.push({ step: 'wifi', ok: false, msg: `❌ Error eliminando producto WiFi: ${deleteResult.error || 'desconocido'}` });
        continueWithBaja = false;
      }
    } catch (e: any) {
      steps.push({ step: 'wifi', ok: false, msg: `❌ Excepción eliminando WiFi: ${e.message}` });
      continueWithBaja = false;
    }

    if (!continueWithBaja) {
      return res.json({ ok: false, steps, error: 'Baja cancelada por error en eliminación de producto WiFi' });
    }

    // Step 2: dar de baja (Geonet acciones + local DB update)
    try {
      const bajaResult = await darDeBajaClienteByServiceId(Number(clientId));
      if (bajaResult.ok) {
        steps.push({ step: 'baja', ok: true, msg: `✅ Cliente dado de baja en Geonet. Estado actualizado a Cancelado.` });
        return res.json({ ok: true, steps, cliente: { nombre: client.nombre, apellidos: client.apellidos, usuario: client.usuario, cedula: client.cedula } });
      } else {
        steps.push({ step: 'baja', ok: false, msg: `❌ Error en baja Geonet: ${bajaResult.error || 'desconocido'}` });
        return res.json({ ok: false, steps, error: bajaResult.error });
      }
    } catch (e: any) {
      steps.push({ step: 'baja', ok: false, msg: `❌ Excepción en baja: ${e.message}` });
      return res.json({ ok: false, steps, error: e.message });
    }
  } catch (e: any) {
    console.error('[wizard] submitBajaWizard error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// POST /wizard/fotos/upload
// Body: { clientId: number, imageDataUrl: string, titulo?: string, descripcion?: string }
export async function uploadFotoWizard(req: any, res: any) {
  const { clientId, imageDataUrl, titulo, descripcion } = req.body || {};
  try {
    if (!clientId) return res.status(400).json({ ok: false, error: 'clientId requerido' });
    if (!imageDataUrl || typeof imageDataUrl !== 'string') return res.status(400).json({ ok: false, error: 'imageDataUrl requerido' });

    const matches = imageDataUrl.match(/^data:(image\/[-a-zA-Z0-9.+]+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ ok: false, error: 'imageDataUrl inválido' });

    const [, mimeType, base64] = matches;
    const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    const fileName = `wizard_foto_${Date.now()}.${ext}`;
    const uploadDir = path.join(process.cwd(), 'uploads', 'chat');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    const systemPath = path.join(uploadDir, fileName);
    fs.writeFileSync(systemPath, Buffer.from(base64, 'base64'));

    const clientRepo = AppDataSource.getRepository(Client);
    const client = await clientRepo.findOne({ where: { id_servicio: Number(clientId) } });
    if (!client) return res.status(404).json({ ok: false, error: 'Cliente no encontrado' });

    const rawUser = client.usuario || client.usuario_rb || client.email || String(clientId);
    const clienteUsuario = rawUser.includes('@geonet') ? rawUser : `${rawUser}@geonet`;

    const ok = await uploadDocumentoCliente(
      Number(clientId),
      clienteUsuario,
      systemPath,
      titulo || `Evidencia Instalación - ${new Date().toLocaleTimeString('es-CL')}`,
      descripcion || 'Foto adjunta desde GeoNetBot'
    );

    return res.json({ ok, usuario: clienteUsuario });
  } catch (e: any) {
    console.error('[wizard] uploadFotoWizard error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
