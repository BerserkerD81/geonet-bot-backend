export interface ApptvDevice {
    mac: string;
    serial: string;
    userid: string | null;
    version: string;
    last_ip: string;
    last_connection: string;
    created: string;
    last_assignment: string | null;
}

export interface ApptvCreateUserResponse {
    status: string;
    user_id: number;
    wisphub_username: string;
    message: string;
}

export interface ApptvDevicesResponse {
    status: string;
    total: number;
    page: number;
    per_page: number;
    data: ApptvDevice[];
}

export interface ApptvLinkResponse {
    status: string;
    linked: number;
    skiped: number;
    user: string;
    ip: string;
    devices: { serial: string; mac: string }[];
    message?: string;
}

export interface ApptvUnlinkMacResponse {
    status: string;
    mac_address: string;
    device_id: string;
    action: string;
    was_linked_to: string | null;
    message: string;
}

export interface ApptvUnlinkIpResponse {
    status: string;
    ip: string;
    action: string;
    total: number;
    devices: { device_id: string; mac_address: string; was_linked_to: string | null }[];
    message: string;
}

export class ApptvClient {
    baseUrl: string;
    bearerToken: string;

    constructor() {
        this.baseUrl = process.env.APPTV_BASE_URL || '';
        this.bearerToken = process.env.APPTV_API_BEARER_TOKEN || '';
        console.log(`[ApptvClient] init baseUrl=${this.baseUrl} token=${this.bearerToken ? '✓ presente' : '✗ VACÍO'}`);
    }

    private get headers() {
        return {
            'Authorization': `Bearer ${this.bearerToken}`,
            'Content-Type': 'application/json',
        };
    }

    async createUser(
        username: string,
        full_name: string,
        phone: string,
        address: string,
        lat: number,
        lng: number,
        ips?: string[],
    ): Promise<ApptvCreateUserResponse | null> {
        const url = `${this.baseUrl}users/create`;
        const payload = { username, full_name, phone, address, lat, lng, ips };
        console.log(`[ApptvClient] POST ${url} | payload=${JSON.stringify(payload)}`);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify(payload),
            });
            const rawBody = await res.text();
            console.log(`[ApptvClient] POST users/create → HTTP ${res.status} | body=${rawBody}`);
            if (!res.ok) {
                console.warn(`[ApptvClient] createUser failed status=${res.status}`);
                return null;
            }
            const data = JSON.parse(rawBody) as ApptvCreateUserResponse;
            console.log(`[ApptvClient] createUser OK user_id=${data.user_id}`);
            return data;
        } catch (e: any) {
            console.error(`[ApptvClient] createUser error: ${e?.message || e}`);
            return null;
        }
    }

    async getDevicesByIp(ip: string, status?: 'active' | 'inactive' | 'all'): Promise<ApptvDevicesResponse | null> {
        const params = new URLSearchParams({ last_ip: ip });
        if (status) params.set('status', status);
        const url = `${this.baseUrl}devices?${params}`;
        console.log(`[ApptvClient] GET ${url}`);
        try {
            const res = await fetch(url, {
                headers: this.headers,
            });
            console.log(`[ApptvClient] GET devices?last_ip=${ip} → HTTP ${res.status}`);
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                console.warn(`[ApptvClient] getDevicesByIp failed status=${res.status} body=${body}`);
                return null;
            }
            const data = await res.json() as ApptvDevicesResponse;
            console.log(`[ApptvClient] getDevicesByIp raw:`, JSON.stringify(data));
            data.data = data.data ?? [];
            console.log(`[ApptvClient] getDevicesByIp OK last_ip=${ip} total=${data.total} devices=[${data.data.map((d: ApptvDevice) => d.mac).join(', ')}]`);
            return data;
        } catch (e: any) {
            console.error(`[ApptvClient] getDevicesByIp error: ${e?.message || e}`);
            return null;
        }
    }

    async linkDevices(
        wisphub_username: string,
        ip_address: string,
        overwrite = false,
    ): Promise<ApptvLinkResponse | null> {
        const url = `${this.baseUrl}devices/link`;
        const linkPayload = { username: wisphub_username, ip_address, overwrite };
        console.log(`[ApptvClient] POST ${url} | payload=${JSON.stringify(linkPayload)}`);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify(linkPayload),
            });
            const rawBody = await res.text();
            console.log(`[ApptvClient] POST devices/link → HTTP ${res.status} | body=${rawBody}`);
            if (!res.ok) {
                console.warn(`[ApptvClient] linkDevices failed status=${res.status}`);
                return null;
            }
            const data = JSON.parse(rawBody) as ApptvLinkResponse;
            console.log(`[ApptvClient] linkDevices OK linked=${data.linked} skiped=${data.skiped} devices=[${data.devices?.map(d => d.mac).join(', ')}]`);
            return data;
        } catch (e: any) {
            console.error(`[ApptvClient] linkDevices error: ${e?.message || e}`);
            return null;
        }
    }

    async deleteDeviceByMac(mac: string): Promise<ApptvUnlinkMacResponse | null> {
        const url = `${this.baseUrl}devices/${encodeURIComponent(mac)}`;
        console.log(`[ApptvClient] DELETE ${url}`);
        try {
            const res = await fetch(url, {
                method: 'DELETE',
                headers: this.headers,
            });
            console.log(`[ApptvClient] DELETE devices/${mac} → HTTP ${res.status}`);
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                console.warn(`[ApptvClient] deleteDeviceByMac failed mac=${mac} status=${res.status} body=${body}`);
                return null;
            }
            const data = await res.json() as ApptvUnlinkMacResponse;
            console.log(`[ApptvClient] deleteDeviceByMac OK mac=${mac} was_linked_to=${data.was_linked_to}`);
            return data;
        } catch (e: any) {
            console.error(`[ApptvClient] deleteDeviceByMac error mac=${mac}: ${e?.message || e}`);
            return null;
        }
    }

    async deleteDevicesByIp(ip: string): Promise<ApptvUnlinkIpResponse | null> {
        const url = `${this.baseUrl}devices?ip=${encodeURIComponent(ip)}`;
        console.log(`[ApptvClient] DELETE ${url}`);
        try {
            const res = await fetch(url, {
                method: 'DELETE',
                headers: this.headers,
            });
            console.log(`[ApptvClient] DELETE devices?ip=${ip} → HTTP ${res.status}`);
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                console.warn(`[ApptvClient] deleteDevicesByIp failed ip=${ip} status=${res.status} body=${body}`);
                return null;
            }
            const data = await res.json() as ApptvUnlinkIpResponse;
            console.log(`[ApptvClient] deleteDevicesByIp OK ip=${ip} total=${data.total}`);
            return data;
        } catch (e: any) {
            console.error(`[ApptvClient] deleteDevicesByIp error ip=${ip}: ${e?.message || e}`);
            return null;
        }
    }
}
