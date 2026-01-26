import { Request, Response } from 'express';
import { authorizeOnu, getOdbs, getOnuTypesByPonType, getOltVlans, listOlts, setOnuWanModeStaticIp, updateOnuLocation } from '../services/smartoltClient';
import { refreshClientsByTerm, searchLocal as searchClientsLocal } from '../services/wisphubClient';

function normalizeVlanValues(values: any): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const v of values) {
    let candidate: any = v;
    if (v && typeof v === 'object') {
      const id = (v as any).vlan_id ?? (v as any).vlan ?? (v as any).id ?? (v as any).value ?? (v as any).pon_vlan?.vlan_id;
      const name = (v as any).name ?? (v as any).description ?? (v as any).label ?? (v as any).vlan_name;
      if (id && name) {
        candidate = `${id} - ${name}`;
      } else {
        candidate = id ?? name;
      }
    }
    const s = String(candidate ?? '').trim();
    if (s) out.push(s);
  }
  return Array.from(new Set(out));
}

function normalizeSpeedProfileName(val: any): string | undefined {
  const raw = val === undefined || val === null ? '' : String(val).trim();
  if (!raw) return undefined;
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  if (!match) return raw;
  const num = match[1].replace(/\.0+$/, '');
  return `${num}M`;
}

function buildPrefilledAuth(defaults: Record<string, any> = {}) {
  const collected: Record<string, any> = {};
  if (defaults.sn) collected.sn = defaults.sn;
  if (defaults.name) collected.name = defaults.name;
  if (defaults.zone) collected.zone = defaults.zone;
  if (defaults.address_or_comment) collected.address_or_comment = defaults.address_or_comment;
  const normDown = normalizeSpeedProfileName(defaults.download_speed_profile_name);
  const normUp = normalizeSpeedProfileName(defaults.upload_speed_profile_name);
  if (normDown) collected.download_speed_profile_name = normDown;
  if (normUp) collected.upload_speed_profile_name = normUp;
  collected.pon_type = 'gpon';
  collected.onu_mode = 'Routing';
  return collected;
}

function buildAuthActions(state: any): any[] {
  const defaults = state.defaults || {};
  const collected = state.collected || {};
  const vlanOptions: string[] = state.vlanOptions || [];
  const onuTypeOptions: string[] = state.onuTypeOptions || [];
  const zoneOptions: string[] = state.zoneOptions || [];
  const odbOptions: string[] = (state.odbOptions || []).map((o: any) => o.name || o.id || '').filter(Boolean);
  const actions: any[] = [];
  if (!collected.olt_id) actions.push({ id: 'auth-olt_id', type: 'input', label: `OLT ID`, helperText: 'ID numérico de la OLT destino', payload: 'auth set olt_id {input}' });
  actions.push({ id: 'auth-pon_type', type: 'input', label: `PON type`, placeholder: 'gpon', helperText: 'Tipo de PON: gpon o epon', options: ['gpon','epon'], payload: 'auth set pon_type {input}' });
  if (!collected.board) actions.push({ id: 'auth-board', type: 'input', label: `Board`, placeholder: `${collected.board || '2'}`, payload: 'auth set board {input}' });
  if (!collected.port) actions.push({ id: 'auth-port', type: 'input', label: `Port`, placeholder: `${collected.port || '2'}`, payload: 'auth set port {input}' });
  actions.push({ id: 'auth-sn', type: 'input', label: `SN/MAC`, placeholder: collected.sn || 'Ej: ZTEGC7E230E4', payload: 'auth set sn {input}' });
  actions.push({ id: 'auth-onu_type', type: 'input', label: `ONU Type`, placeholder: 'Ej: ZTE-F660V6.0', options: onuTypeOptions, payload: 'auth set onu_type {input}' });
  actions.push({ id: 'auth-onu_mode', type: 'input', label: `ONU Mode`, placeholder: 'Routing', options: ['Routing','Bridging'], payload: 'auth set onu_mode {input}' });
  actions.push({ id: 'auth-vlan', type: 'input', label: `VLAN`, placeholder: 'Ej: 100', options: vlanOptions, payload: 'auth set vlan {input}' });
  actions.push({ id: 'auth-zone', type: 'input', label: `Zona`, placeholder: defaults.zone || 'Ciudad o zona', options: zoneOptions, payload: 'auth set zone {input}' });
  actions.push({ id: 'auth-odb', type: 'input', label: `ODB/Splitter`, placeholder: 'Selecciona ODB', options: odbOptions, payload: 'auth set odb {input}' });
  actions.push({ id: 'auth-odb-port', type: 'input', label: `Puerto ODB`, placeholder: '1', payload: 'auth set odb_port {input}' });
  actions.push({ id: 'auth-name', type: 'input', label: `Nombre`, placeholder: defaults.name || 'Nombre y Apellido', payload: 'auth set name {input}' });
  actions.push({ id: 'auth-address', type: 'input', label: `Dirección/Comentario/Etiqueta Roja`, placeholder: defaults.address_or_comment || 'Dirección de instalación', payload: 'auth set address_or_comment {input}' });
  actions.push({ id: 'auth-speed', type: 'input', label: `Velocidad (M)`, placeholder: defaults.download_speed_profile_name || '200M', options: ['200M','400M','600M','800M'], helperText: 'Velocidad simétrica' });
  actions.push({ id: 'auth-submit', type: 'button', label: 'Autorizar SmartOLT ahora', payload: 'auth submit' });
  return actions;
}

function buildWanActions(collected: Record<string, any>): any[] {
  const ipCandidates = [collected.ipv4_address, collected.ipv4, collected.ip, collected.client_ip, collected.cliente_ip, collected.customer_ip, collected.service_ip];
  const ipRaw = ipCandidates.find((v) => v !== undefined && v !== null && String(v).trim() !== '');
  const ip = ipRaw ? String(ipRaw).trim() : '';

  const actions: any[] = [];
  actions.push({ id: 'wan-sn', type: 'input', label: `SN/MAC`, placeholder: collected.sn || '', payload: 'wan set sn {input}' });
  actions.push({ id: 'wan-onu_external_id', type: 'input', label: `ONU External ID`, placeholder: collected.onu_external_id ? String(collected.onu_external_id) : '', payload: 'wan set onu_external_id {input}' });
  actions.push({ id: 'wan-ipv4', type: 'input', label: `WAN IPv4`, placeholder: ip || 'Ej: 10.100.0.11', payload: 'wan set ipv4_address {input}' });
  actions.push({ id: 'wan-subnet', type: 'input', label: `WAN Subnet Mask`, placeholder: collected.subnet_mask || '255.255.255.0', payload: 'wan set subnet_mask {input}' });
  let gatewayPlaceholder = collected.gateway || '';
  if (!gatewayPlaceholder && ip) {
    const ipParts = ip.split('.');
    if (ipParts.length === 4) gatewayPlaceholder = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}.254`;
  }
  actions.push({ id: 'wan-gateway', type: 'input', label: `WAN Gateway`, placeholder: gatewayPlaceholder || 'Ej: 10.100.0.254', payload: 'wan set gateway {input}' });
  actions.push({ id: 'wan-dns1', type: 'input', label: `WAN DNS1`, placeholder: collected.dns1 || '8.8.8.8', payload: 'wan set dns1 {input}' });
  actions.push({ id: 'wan-dns2', type: 'input', label: `WAN DNS2`, placeholder: collected.dns2 || '8.8.4.4', payload: 'wan set dns2 {input}' });
  actions.push({ id: 'wan-apply', type: 'button', label: 'Autorizar WAN estático ahora', payload: 'wan apply' });
  return actions;
}

export async function initiateAuth(req: Request, res: Response) {
  const session = req.session as any;
  const userId = session?.userId;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  try {
    const defaults = (req.body?.defaults && typeof req.body.defaults === 'object') ? req.body.defaults : {};
    const state: any = { defaults, collected: buildPrefilledAuth(defaults) };

    // Fetch options
    const [olts, zones, odbs, onuTypesGpon, onuTypesEpon] = await Promise.all([
      listOlts().catch(() => []),
      // Zones via SmartOLT API (names only)
      (await import('../services/smartoltClient')).getZones().catch(() => []),
      getOdbs().catch(() => []),
      getOnuTypesByPonType('gpon').catch(() => []),
      getOnuTypesByPonType('epon').catch(() => []),
    ]);

    // Prepare VLAN options for first few OLTs (best-effort)
    const vlanOptions: string[] = [];
    for (const o of (olts || []).slice(0, 3)) {
      const vlans = await getOltVlans(o.id).catch(() => [] as any[]);
      normalizeVlanValues(vlans).forEach((v) => { if (!vlanOptions.includes(v)) vlanOptions.push(v); });
    }

    state.zoneOptions = (zones || []).map((z: any) => z.name || z.id).filter(Boolean);
    state.odbOptions = odbs || [];
    const typesGpon: string[] = Array.isArray(onuTypesGpon) ? (onuTypesGpon as string[]) : [];
    const typesEpon: string[] = Array.isArray(onuTypesEpon) ? (onuTypesEpon as string[]) : [];
    state.onuTypeOptions = ([] as string[]).concat(typesGpon, typesEpon);
    state.vlanOptions = vlanOptions;

    const actions = buildAuthActions(state);
    const metadata = {
      smartoltAvailability: { olts: olts || [] }
    };
    session.pendingAuth = state;
    return res.json({ ok: true, message: 'Completa los datos para autorizar en SmartOLT.', actions, metadata });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to initiate auth' });
  }
}

export async function initiateWan(req: Request, res: Response) {
  const session = req.session as any;
  const userId = session?.userId;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  try {
    const collected = { ...(session?.pendingAuth?.collected || {}), ...(req.body || {}) } as Record<string, any>;
    const actions = buildWanActions(collected);
    session.pendingWan = collected;
    return res.json({ ok: true, message: 'Completa los datos para configurar WAN estático.', actions });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to initiate WAN' });
  }
}

export async function submitAuth(req: Request, res: Response) {
  const session = req.session as any;
  const userId = session?.userId;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const bodyCollected = (req.body as any)?.collected;
  const state = session?.pendingAuth || {};
  const collected = typeof bodyCollected === 'object' && bodyCollected !== null ? { ...(state.collected || {}), ...bodyCollected } : (state.collected || {});
  const defaults = state.defaults || {};

  const merged: Record<string, any> = { ...defaults, ...collected } as any;
  merged.pon_type = merged.pon_type || 'gpon';
  merged.onu_mode = merged.onu_mode || 'Routing';

  if (!merged.sn || String(merged.sn).trim() === '') {
    if ((req.body as any)?.sn) merged.sn = (req.body as any).sn;
    if ((!merged.sn || String(merged.sn).trim() === '') && (req.body as any)?.placeholder_sn) merged.sn = (req.body as any).placeholder_sn;
    if ((!merged.sn || String(merged.sn).trim() === '') && state?.collected?.sn) merged.sn = state.collected.sn;
    if ((!merged.sn || String(merged.sn).trim() === '') && defaults?.sn) merged.sn = defaults.sn;
  }

  const required = ['olt_id','sn','onu_type','zone','name'];
  const missing = required.filter((k) => !merged[k] || String(merged[k]).trim() === '');
  if (missing.length > 0) {
    return res.status(400).json({ error: `missing_fields`, details: missing });
  }

  try {
    const payload: any = {
      olt_id: merged.olt_id,
      pon_type: merged.pon_type,
      sn: merged.sn,
      onu_type: merged.onu_type,
      onu_mode: merged.onu_mode,
      zone: merged.zone,
      name: merged.name
    };
    if (merged.board) payload.board = merged.board;
    if (merged.port) payload.port = merged.port;
    if (merged.odb) payload.odb = merged.odb;
    if (merged.odb_port) payload.odb_port = isNaN(Number(merged.odb_port)) ? merged.odb_port : Number(merged.odb_port);
    if (merged.vlan) payload.vlan = merged.vlan;
    if (merged.address_or_comment) payload.address_or_comment = merged.address_or_comment;
    if (merged.download_speed_profile_name) payload.download_speed_profile_name = merged.download_speed_profile_name;
    if (merged.upload_speed_profile_name) payload.upload_speed_profile_name = merged.upload_speed_profile_name;

    // Validate ONU type exists in SmartOLT
    try {
      const availableTypes = await getOnuTypesByPonType((payload.pon_type || 'gpon') as any).catch(() => [] as string[]);
      const desired = String(payload.onu_type || '').trim();
      const found = (availableTypes || []).some((t: string) => String(t).trim().toLowerCase() === desired.toLowerCase());
      if (!found) {
        return res.status(400).json({ ok: false, error: 'onu_type_not_found', message: `ONU type '${desired}' not present in SmartOLT.` });
      }
    } catch {}

    const result: any = await authorizeOnu(payload);

    if (!merged.onu_external_id && merged.sn) merged.onu_external_id = String(merged.sn);

    let locationUpdateResult: any = null;
    let wanUpdateResult: any = null;
    try {
      const ok = (result && (result.status === true || result.response_code === 'success' || String(result.response || result.response_code || '').toLowerCase().includes('success') || String(result).toLowerCase().includes('onu configuration')));
      if (ok && merged.onu_external_id) {
        const locParams: Record<string, any> = {};
        if (merged.zone) locParams.zone = merged.zone;
        if (merged.odb) locParams.odb = merged.odb;
        if (merged.odb_port) locParams.odb_port = merged.odb_port;
        if (merged.name) locParams.name = merged.name;
        if (merged.address_or_comment) locParams.address_or_comment = merged.address_or_comment;
        if (merged.contact) locParams.contact = merged.contact;
        if (merged.latitude) locParams.latitude = merged.latitude;
        if (merged.longitude) locParams.longitude = merged.longitude;

        if (Object.keys(locParams).length > 0) {
          try {
            locationUpdateResult = await updateOnuLocation(String(merged.onu_external_id), locParams).catch((e) => { throw e; });
          } catch (e: any) {
            // non-fatal
          }
        }
      }
    } catch {}

    try {
      const ipCandidates = [merged.ipv4_address, merged.ipv4, merged.ip, merged.client_ip, merged.cliente_ip, merged.customer_ip, merged.service_ip];
      const ipRaw = ipCandidates.find((v) => v !== undefined && v !== null && String(v).trim() !== '');
      const ip = ipRaw ? String(ipRaw).trim() : '';
      const shouldExecuteWan = merged.execute_wan_now === true || merged.execute_wan_now === 'true' || (req.body as any)?.executeWan === true || (req.body as any)?.executeWan === 'true' || merged.wan_apply_now === true || merged.wan_apply_now === 'true';
      if (ip && merged.onu_external_id && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
        const parts = ip.split('.');
        const gateway = merged.gateway || `${parts[0]}.${parts[1]}.${parts[2]}.254`;
        if (shouldExecuteWan) {
          try {
            wanUpdateResult = await setOnuWanModeStaticIp(String(merged.onu_external_id), ip, merged.subnet_mask || '255.255.255.0', gateway, merged.dns1 || '8.8.8.8', merged.dns2 || '8.8.4.4', { sn: merged.sn, olt_id: merged.olt_id, pon_type: merged.pon_type });
          } catch (e: any) {
            wanUpdateResult = { ok: false, error: e?.response?.data || e?.message || String(e) };
          }
        }
      }
    } catch {}

    if (session.pendingAuth) delete session.pendingAuth;

    try {
      const parts: string[] = [];
      parts.push('ONU autorizada correctamente.');
      if (locationUpdateResult) parts.push('Ubicación actualizada en SmartOLT.');
      if (wanUpdateResult) {
        const ok = (wanUpdateResult && (wanUpdateResult.status === true || wanUpdateResult.ok === true || String(wanUpdateResult).toLowerCase().includes('success')));
        parts.push(ok ? 'WAN configurado correctamente.' : 'Intento de configurar WAN estático falló.');
      }
      const baseMessage = parts.join(' ');
      const actions = buildWanActions(merged);
      return res.json({ ok: true, message: baseMessage + ' Completa los datos para configurar WAN estático.', actions });
    } catch {
      return res.json({ ok: true, message: 'ONU autorizada correctamente' });
    }
  } catch (e: any) {
    const errMsg = e?.response?.data || e?.message || 'Fallo al autorizar';
    return res.status(500).json({ ok: false, error: errMsg });
  }
}

export async function applyPendingWan(req: Request, res: Response) {
  const session = req.session as any;
  const userId = session?.userId;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const pending = session?.pendingWan;
  const body = req.body || {};
  const dataSource = (body && (body as any).ipv4_address) ? body : pending;
  if (!dataSource) return res.status(400).json({ error: 'no_pending_wan' });

  try {
    const extras = (dataSource as any).extras || {};
    const onuExternalId = String((dataSource as any).onu_external_id || (dataSource as any).onuExternalId || (dataSource as any).onu_external || '');
    const ipv4 = (dataSource as any).ipv4_address || (dataSource as any).ipv4 || (dataSource as any).ip || (dataSource as any).ipv4Address || '';
    if (!onuExternalId || !ipv4) return res.status(400).json({ error: 'missing_fields', details: ['onu_external_id','ipv4_address'] });

    let gateway = (dataSource as any).gateway;
    const ipv4Str = String(ipv4);
    if (!gateway && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ipv4Str)) {
      const parts = ipv4Str.split('.');
      if (parts.length === 4) gateway = `${parts[0]}.${parts[1]}.${parts[2]}.254`;
    }

    const result = await setOnuWanModeStaticIp(
      onuExternalId,
      ipv4Str,
      (dataSource as any).subnet_mask || (dataSource as any).subnetMask || '255.255.255.0',
      gateway,
      (dataSource as any).dns1 || '8.8.8.8',
      (dataSource as any).dns2 || '8.8.4.4',
      extras
    );
    if (!body || !(body as any).ipv4_address) {
      try { delete session.pendingWan; } catch {}
    }
    return res.status(200).json({ ok: true, message: 'WAN configurado correctamente', result });
  } catch (e: any) {
    const errMsg = e?.response?.data || e?.message || 'Fallo al aplicar WAN';
    return res.status(500).json({ ok: false, error: errMsg });
  }
}

// GET-like endpoint to list clients by name and respond with button actions
export async function listClientsByNameActions(req: Request, res: Response) {
  const session = req.session as any;
  const userId = session?.userId;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const q = String((req.query?.q ?? req.query?.term ?? '') as string).trim();
  if (!q) return res.status(400).json({ error: 'term required' });

  try {
    await refreshClientsByTerm(q).catch(() => {});
    const results = await searchClientsLocal(q, 30);
    const actions = (results || []).slice(0, 12).map((c: any) => ({
      id: `select-client-${c.id_servicio}`,
      type: 'button',
      label: `${(c.nombre || '')} ${(c.apellidos || '')}`.trim() + (c.id_servicio ? ` [${c.id_servicio}]` : ''),
      payload: `seleccionar cliente ${c.id_servicio}`
    }));
    const names = (results || []).slice(0, 12).map((c: any, i: number) => `${i + 1}. ${((c.nombre || '') + ' ' + (c.apellidos || '')).trim()}${c.id_servicio ? ` [${c.id_servicio}]` : ''}`);
    const message = names.length ? `Clientes encontrados para "${q}":\n${names.join('\n')}` : `No encontré clientes para "${q}"`;
    return res.json({ ok: true, message, actions });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to list clients' });
  }
}
