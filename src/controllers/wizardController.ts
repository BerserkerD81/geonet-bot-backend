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
  getOdbs, getInternalOnuIdBySn, getOnuIdAndIpBySn, getAllOnuTypes,
  listGlobalUnconfiguredOnus, changeOnuType, updateOnuSn,
  rebootOnuByExternalId, resyncOnuConfigByExternalId, updateOnuMgmtIp, saveWifiStatus, getOltVlans,
  continueAuthorize, getOnuSignalByExternalId, deleteOnuBySn,
} from '../services/smartoltClient';
import {
  activarInstalacionGeonet, processContractUpdate, getAutoLoginContractLink,
  refreshClientsByTerm, fullSyncClients, replaceOnuForClient,
  deleteWifiProductByName, darDeBajaClienteByServiceId, uploadDocumentoCliente,
  getClientByServiceId, deleteGeonetTvProducts, liberarGeonetTvEquipos,
} from '../services/wisphubClient';
import { getGenieDeviceId, setGenieWifi } from '../services/genieacsClient';
import { enqueueWifiTask, getWifiTask } from '../services/pendingWifiTasks';
import { ApptvClient } from '../services/apptvVClient';

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

// GET /wizard/auth/installations?sync=true
export async function getAuthWizardInstallations(req: any, res: any) {
  const forceSync = req.query.sync === 'true';
  try {
    if (forceSync) {
      await fullSyncInstallations(100, 50).catch((e: any) => console.warn('[wizard] sync warn:', e?.message));
    }
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
      ip: i.ip,
    }));
    return res.json({ ok: true, results });
  } catch (e: any) {
    console.error('[wizard] getAuthWizardInstallations error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// GET /wizard/auth/wifi/task-status?sn=ZTEGDACC6FAC
export async function getWifiTaskStatus(req: any, res: any) {
  const sn = req.query.sn as string;
  if (!sn) return res.status(400).json({ ok: false, error: 'sn requerido' });
  const task = getWifiTask(String(sn).toUpperCase());
  if (!task) return res.json({ ok: true, found: false });
  return res.json({ ok: true, found: true, task });
}

// GET /wizard/auth/vlans?oltId=3
export async function getVlansWizard(req: any, res: any) {
  const oltId = req.query.oltId as string;
  if (!oltId) return res.status(400).json({ ok: false, error: 'oltId requerido' });
  try {
    const vlans = await getOltVlans(oltId, { cacheTtlMs: 60000 });
    return res.json({ ok: true, vlans });
  } catch (e: any) {
    console.error('[wizard] getVlansWizard error:', e);
    return res.status(500).json({ ok: false, error: e.message, vlans: [] });
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
          board: onu.board || '',
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

// POST /wizard/auth/wifi  body: { sn, ssid, pass, clientIp?, board?, port?, olt_id? }
// Activa TR069 perfil 3, desactiva WiFi en SmartOLT y configura SSID/pass via GenieACS.
export async function applyWifiWizard(req: any, res: any) {
  const session = req.session || {};
  if (!session.userId) return res.status(401).json({ error: 'unauthenticated' });

  const { sn, ssid, pass, clientIp, board, port, olt_id } = req.body;
  if (!sn) return res.status(400).json({ error: 'sn requerido' });
  if (!ssid || !pass) return res.status(400).json({ error: 'ssid y pass requeridos' });

  try {
    let { id: onuId, ip: smartoltIp } = await getOnuIdAndIpBySn(String(sn).toUpperCase());

    // Si la ONU no aparece en configuradas, la autorización quedó incompleta.
    // Intentar finalizar via scraping con los datos del formulario y reintentar.
    if (!onuId && board && port && olt_id) {
      console.log(`[applyWifi] ONU ${sn} no configurada → intentando continue_authorize board=${board} port=${port} olt=${olt_id}`);
      try {
        await continueAuthorize(board, port, String(sn).toUpperCase(), olt_id);
        // Esperar brevemente para que SmartOLT procese
        await new Promise(r => setTimeout(r, 2000));
        const retry = await getOnuIdAndIpBySn(String(sn).toUpperCase());
        onuId = retry.id;
        if (retry.ip) smartoltIp = retry.ip;
      } catch (e: any) {
        console.warn(`[applyWifi] continue_authorize falló: ${e?.message}`);
      }
    }

    if (!onuId) return res.status(404).json({ ok: false, error: `ONU ${sn} no encontrada en SmartOLT. Verifica que la autorización se completó.` });

    // IP live de SmartOLT tiene prioridad; clientIp es fallback por si la respuesta no la incluye
    const resolvedIp = smartoltIp || clientIp || null;

    const results: string[] = [];

    // 1. Activate TR069 profile 3
    try {
      await updateOnuMgmtIp(onuId, { tr069_profile_id: 3 });
      results.push('✅ TR069 perfil 3 activado');
    } catch (e: any) {
      results.push(`❌ TR069: ${e.message}`);
    }

    // 2. Disable SmartOLT WiFi
    try {
      await saveWifiStatus(onuId, false);
      results.push('✅ WiFi SmartOLT desactivado');
    } catch (e: any) {
      results.push(`⚠️ WiFi SmartOLT: ${e.message}`);
    }

    // 3. Configure SSID/pass via GenieACS
    let genieTaskQueued = false;
    try {
      const deviceId = await getGenieDeviceId(resolvedIp);
      if (!deviceId) {
        // ONU aún no se registró en GenieACS — encolar tarea en background
        enqueueWifiTask(String(sn).toUpperCase(), String(ssid), String(pass), resolvedIp).catch(() => {});
        genieTaskQueued = true;
        results.push('⏳ GenieACS: dispositivo no encontrado aún — tarea creada para configurar WiFi automáticamente cuando la ONU conecte (cada 90s, hasta 15 min)');
      } else {
        const genieResult = await setGenieWifi(deviceId, String(ssid), String(pass));
        const ssid5g = `${String(ssid)}_5G`;
        if (genieResult?._queued) {
          results.push(`✅ GenieACS: tarea guardada — se aplicará en la próxima sesión TR069 (2.4GHz: "${ssid}" | 5GHz: "${ssid5g}")`);
        } else {
          results.push(`✅ WiFi configurado vía GenieACS — 2.4GHz: "${ssid}" | 5GHz: "${ssid5g}"`);
        }
      }
    } catch (e: any) {
      results.push(`❌ GenieACS: ${e.message}`);
    }

    const allFailed = results.every(r => r.startsWith('❌'));
    return res.json({ ok: !allFailed, results, genieTaskQueued });
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

// POST /wizard/auth/tr069  body: { sn }
export async function activateTr069Wizard(req: any, res: any) {
  const session = req.session || {};
  if (!session.userId) return res.status(401).json({ error: 'unauthenticated' });

  const { sn } = req.body;
  if (!sn) return res.status(400).json({ error: 'sn requerido' });

  try {
    const onuId = await getInternalOnuIdBySn(String(sn).toUpperCase());
    if (!onuId) {
      return res.status(404).json({ ok: false, error: `No se encontró ID interno para SN ${sn}` });
    }

    const result = await updateOnuMgmtIp(onuId, { tr069_profile_id: 3 });
    return res.json({ ok: true, onuId, result });
  } catch (e: any) {
    console.error('[wizard] activateTr069Wizard error:', e);
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

    // If client.sn_onu was updated after a swap, the snapshot may still point to the old ONU.
    // Prefer client.sn_onu when it differs from the snapshot SN.
    if (client.sn_onu) {
      const currentSn = String(client.sn_onu).trim();
      if (!resolvedOnu || (resolvedOnu.sn && resolvedOnu.sn !== currentSn)) {
        resolvedOnu = {
          sn: currentSn,
          model: resolvedOnu?.model || '',
          externalId: currentSn,
        };
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

    // Step 2: delete ONU from SmartOLT (by SN resolved from client IP via local snapshot)
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
          const snRaw = String(detail.sn || p.sn || p.serial || p.onu_sn || '').trim();
          const externalId = String(detail.uniqueExternalId || p.onu_external_id || p.unique_external_id || p.external_id || snRaw).trim();
          const sn = snRaw.toUpperCase();

          if (externalId) {
            const deleteResult = await deleteOnuBySn(externalId);
            if (deleteResult.ok) {
              steps.push({ step: 'smartolt', ok: true, msg: `✅ ONU eliminada de SmartOLT (SN: ${sn || externalId})` });
            } else {
              steps.push({ step: 'smartolt', ok: false, msg: `⚠️ No se pudo eliminar ONU de SmartOLT (SN: ${sn || externalId}): ${deleteResult.error || 'error desconocido'} — se continúa con la baja` });
            }
          } else {
            steps.push({ step: 'smartolt', ok: false, msg: `⚠️ ONU encontrada en snapshot pero sin SN/ID para eliminar (IP: ${client.ip}) — se continúa` });
          }
        } else {
          steps.push({ step: 'smartolt', ok: false, msg: `⚠️ No se encontró ONU en SmartOLT para IP ${client.ip} — se continúa con la baja` });
        }
      } catch (e: any) {
        steps.push({ step: 'smartolt', ok: false, msg: `⚠️ Error buscando ONU en SmartOLT: ${e.message} — se continúa con la baja` });
      }
    } else {
      steps.push({ step: 'smartolt', ok: false, msg: `⚠️ Cliente sin IP registrada, se omite eliminación de ONU en SmartOLT` });
    }

    // Step 3: dar de baja (TR-069 GenieACS + Geonet acciones + local DB update)
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

// GET /wizard/signal?sn=X
export async function getOnuSignalWizard(req: any, res: any) {
  const sn = ((req.query.sn as string) || '').trim().toUpperCase();
  if (!sn) return res.status(400).json({ ok: false, error: 'sn requerido' });
  try {
    const data = await getOnuSignalByExternalId(sn);
    if (!data?.status) {
      return res.json({ ok: false, error: data?.error || 'ONU no encontrada en SmartOLT' });
    }
    const signal1490 = String(data.onu_signal_1490 || '').trim();
    const signal1310 = String(data.onu_signal_1310 || '').trim();
    const signalValue = String(data.onu_signal_value || '').trim();
    const statusSummary = String(data.onu_signal || '').trim();
    const quality = classifyOnuSignalQuality({ signal1490, signalValue, statusSummary });
    return res.json({ ok: true, signal1490, signal1310, signalValue, statusSummary, quality });
  } catch (e: any) {
    console.error('[wizard] getOnuSignalWizard error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// GET /wizard/iptv/devices?ip=...
export async function getIptvDevices(req: any, res: any) {
  const session = req.session || {};
  if (!session.userId) return res.status(401).json({ error: 'unauthenticated' });

  const ip = ((req.query.ip as string) || '').trim();
  console.log(`[wizard/iptv/devices] GET ip=${ip || '(vacío)'} userId=${session.userId}`);
  if (!ip) return res.status(400).json({ ok: false, error: 'ip requerido' });

  try {
    const client = new ApptvClient();
    const result = await client.getDevicesByIp(ip);
    if (!result) {
      console.warn(`[wizard/iptv/devices] Sin dispositivos para ip=${ip}`);
      return res.status(404).json({ ok: false, error: 'No se encontraron dispositivos para esa IP' });
    }
    const devices = (result.data ?? []).map(d => ({
      mac: d.mac,
      serial: d.serial,
      userid: d.userid,
      last_ip: d.last_ip,
      last_connection: d.last_connection,
      created: d.created,
    }));
    console.log(`[wizard/iptv/devices] OK ip=${ip} total=${result.total} macs=[${devices.map(d => d.mac).join(', ')}]`);
    return res.json({ ok: true, total: result.total, devices });
  } catch (e: any) {
    console.error(`[wizard/iptv/devices] Error ip=${ip}:`, e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// POST /wizard/iptv/link  body: { id_servicio, ip_address, overwrite? }
export async function linkIptvDevices(req: any, res: any) {
  const session = req.session || {};
  if (!session.userId) return res.status(401).json({ error: 'unauthenticated' });

  const id_servicio: string = String(req.body?.id_servicio || '').trim();
  const ip_address: string = String(req.body?.ip_address || '').trim();

  console.log(`[wizard/iptv/link] POST id_servicio=${id_servicio} ip=${ip_address} userId=${session.userId}`);
  if (!id_servicio) return res.status(400).json({ ok: false, error: 'id_servicio requerido' });
  if (!ip_address) return res.status(400).json({ ok: false, error: 'ip_address requerido' });

  try {
    // 1. Obtener datos completos del cliente desde WispHub
    const whClient = await getClientByServiceId(id_servicio);
    if (!whClient) {
      console.warn(`[wizard/iptv/link] Cliente id_servicio=${id_servicio} no encontrado en WispHub`);
      return res.status(404).json({ ok: false, error: 'Cliente no encontrado en WispHub' });
    }

    const usuario_rb: string = String(whClient.usuario_rb || whClient.usuario || id_servicio).trim();
    const full_name: string = [whClient.nombre, whClient.apellidos].filter(Boolean).join(' ').trim() || usuario_rb;
    const phone: string = String(whClient.telefono || '').trim();
    const address: string = String(whClient.direccion || '').trim();
    const ips: string[] = ip_address ? [ip_address] : [];

    // Parsear coordenadas "lat,lng"
    let lat = 0;
    let lng = 0;
    const coords = String(whClient.coordenadas || '').trim();
    if (coords) {
      const parts = coords.split(',').map((s: string) => parseFloat(s.trim()));
      if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        lat = parts[0];
        lng = parts[1];
      }
    }

    console.log(`[wizard/iptv/link] WispHub → usuario_rb=${usuario_rb} nombre="${full_name}" coords=${lat},${lng}`);

    // 2. Crear/actualizar usuario en AppTV
    const apptv = new ApptvClient();
    const createResult = await apptv.createUser(usuario_rb, full_name, phone, address, lat, lng, ips);
    if (createResult) {
      console.log(`[wizard/iptv/link] createUser OK user_id=${createResult.user_id}`);
    } else {
      console.warn(`[wizard/iptv/link] createUser falló o usuario ya existe, continuando con linkDevices`);
    }

    // 3. Vincular dispositivos por IP al usuario
    const linkResult = await apptv.linkDevices(usuario_rb, ip_address, true);
    if (!linkResult) {
      console.warn(`[wizard/iptv/link] linkDevices sin resultado para usuario_rb=${usuario_rb} ip=${ip_address}`);
      return res.status(400).json({ ok: false, error: 'No se pudo vincular los dispositivos' });
    }
    console.log(`[wizard/iptv/link] linkDevices OK linked=${linkResult.linked} skiped=${linkResult.skiped}`);
    return res.json({ ok: true, usuario_rb, ...linkResult });
  } catch (e: any) {
    console.error(`[wizard/iptv/link] Error:`, e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// POST /wizard/iptv/unlink  body: { macs: string[], id_servicio?: string }
export async function unlinkIptvDevices(req: any, res: any) {
  const session = req.session || {};
  if (!session.userId) return res.status(401).json({ error: 'unauthenticated' });

  const macs: string[] = Array.isArray(req.body?.macs) ? req.body.macs : [];
  const id_servicio: string = String(req.body?.id_servicio || '').trim();
  console.log(`[wizard/iptv/unlink] POST macs=[${macs.join(', ')}] id_servicio=${id_servicio || '—'} userId=${session.userId}`);
  if (!macs.length) return res.status(400).json({ ok: false, error: 'macs requerido' });

  try {
    // 1. Desvincular dispositivos en AppTV
    const apptv = new ApptvClient();
    const aptvResults = await Promise.all(
      macs.map(async (mac) => {
        const r = await apptv.deleteDeviceByMac(mac);
        return { mac, ok: !!r, was_linked_to: r?.was_linked_to ?? null };
      })
    );
    const aptvOk = aptvResults.every(r => r.ok);
    const aptvOkCount = aptvResults.filter(r => r.ok).length;
    console.log(`[wizard/iptv/unlink] AppTV ${aptvOkCount}/${aptvResults.length} desvinculados | ${JSON.stringify(aptvResults)}`);

    // 2. Eliminar productos TV (decos) en Geonet admin si se proporcionó id_servicio
    let geonetResult: { ok: boolean; deleted: { uuid: string; nombre: string; ok: boolean; error?: string }[] } | null = null;
    if (id_servicio) {
      const repo = AppDataSource.getRepository(require('../models/Client').Client);
      const clientEntity = await repo.findOne({ where: { id_servicio: Number(id_servicio) } });
      const usuario_rb = clientEntity?.usuario_rb || clientEntity?.usuario || null;
      if (usuario_rb) {
        console.log(`[wizard/iptv/unlink] Eliminando decos Geonet para usuario_rb=${usuario_rb}`);
        geonetResult = await deleteGeonetTvProducts(usuario_rb, macs.length);
        console.log(`[wizard/iptv/unlink] Geonet decos → ok=${geonetResult.ok} deleted=${JSON.stringify(geonetResult.deleted)}`);
        const equiposResult = await liberarGeonetTvEquipos(usuario_rb, macs.length);
        console.log(`[wizard/iptv/unlink] Geonet equipos → ok=${equiposResult.ok} liberated=${JSON.stringify(equiposResult.liberated)}`);
      } else {
        console.warn(`[wizard/iptv/unlink] Sin usuario_rb para id_servicio=${id_servicio}, se omite Geonet`);
      }
    }

    return res.json({ ok: aptvOk, results: aptvResults, geonet: geonetResult });
  } catch (e: any) {
    console.error(`[wizard/iptv/unlink] Error:`, e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
