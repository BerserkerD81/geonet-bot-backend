import axios from 'axios';
import { GENIEACS } from '../config';

const WAN_IP_PATHS = [
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.2.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.2.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
];

export async function getGenieDeviceId(ip: string | null | undefined): Promise<string | null> {
  if (ip) {
    for (const path of WAN_IP_PATHS) {
      try {
        const res = await axios.get(`${GENIEACS.url}/devices`, {
          params: { query: JSON.stringify({ [`${path}._value`]: ip }), projection: '_id' },
          timeout: 8000,
        });
        const devices: any[] = Array.isArray(res.data) ? res.data : [];
        if (devices.length > 0) return String(devices[0]._id);
      } catch { /* try next path */ }
    }
  }
  return null;
}

export async function deleteGenieDevice(deviceId: string): Promise<boolean> {
  try {
    const res = await axios.delete(
      `${GENIEACS.url}/devices/${encodeURIComponent(deviceId)}`,
      { timeout: 10000, validateStatus: (s: number) => s < 500 }
    );
    return res.status === 200 || res.status === 204;
  } catch {
    return false;
  }
}

export async function deleteGenieDeviceByIp(ip: string): Promise<{ ok: boolean; deviceId: string | null }> {
  const deviceId = await getGenieDeviceId(ip);
  if (!deviceId) return { ok: false, deviceId: null };
  const ok = await deleteGenieDevice(deviceId);
  return { ok, deviceId };
}

export async function setGenieWifi(deviceId: string, ssid: string, password: string): Promise<any> {
  const ssid5g = `${ssid} 5G`;
  const parameterValues: [string, string, string][] = [
    [`${GENIEACS.wifi2gBase}.SSID`, ssid, 'xsd:string'],
    [`${GENIEACS.wifi2gBase}.${GENIEACS.wifiPassParam}`, password, 'xsd:string'],
    [`${GENIEACS.wifi5gBase}.SSID`, ssid5g, 'xsd:string'],
    [`${GENIEACS.wifi5gBase}.${GENIEACS.wifiPassParam}`, password, 'xsd:string'],
  ];

  try {
    const res = await axios.post(
      `${GENIEACS.url}/devices/${encodeURIComponent(deviceId)}/tasks?connection_request`,
      { name: 'setParameterValues', parameterValues },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
        validateStatus: (s: number) => s < 500,
      }
    );
    return res.data;
  } catch (e: any) {
    // GenieACS saves the task before attempting connection_request. A timeout means
    // the immediate push failed but the task is queued and will apply on next TR069 session.
    if (e.code === 'ECONNABORTED' || e.message?.includes('timeout')) {
      return { _queued: true };
    }
    throw e;
  }
}
