const cds  = require('@sap/cds');
const http = require('http');

const DH  = 'com.riotinto.s4.v.ZCLDeliveryHeaders';
const DI  = 'com.riotinto.s4.v.ZCLDeliveryItems';

const SAP_CLIENT   = process.env.S4_CLIENT      || '510';
const DESTINATION  = process.env.S4_DESTINATION || 'RD1CLNT510_HTTPS';
const DEST_PROXY   = process.env.DESTINATION_PROXY_URL || 'http://secure-outbound-connectivity.webide-system';

// ─── HTTP via BAS destination proxy ──────────────────────────────────────────

function s4Request(method, path, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const targetUrl  = `http://secure-outbound-connectivity.webide-system/destinations/${DESTINATION}${path}`;
        const bodyBuf    = body ? Buffer.from(body) : undefined;
        const reqHeaders = {
            'Host':       'secure-outbound-connectivity.webide-system',
            'sap-client': SAP_CLIENT,
            'Connection': 'close',
            ...headers
        };
        if (bodyBuf) reqHeaders['Content-Length'] = bodyBuf.length;

        const net = require('net');
        const bodyStr     = bodyBuf ? bodyBuf.toString() : '';
        const headerLines = Object.entries(reqHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n');
        const raw         = `${method} ${targetUrl} HTTP/1.1\r\n${headerLines}\r\n\r\n${bodyStr}`;

        const socket = net.createConnection(8887, '127.0.0.1', () => socket.write(raw));
        let data = '';
        socket.on('data', chunk => data += chunk);
        socket.on('end', () => {
            const idx        = data.indexOf('\r\n\r\n');
            const head       = data.substring(0, idx);
            const body       = data.substring(idx + 4);
            const statusLine = head.split('\r\n')[0];
            const status     = parseInt(statusLine.split(' ')[1]);
            const resHeaders = {};
            head.split('\r\n').slice(1).forEach(l => {
                const sep = l.indexOf(': ');
                if (sep > 0) resHeaders[l.substring(0, sep).toLowerCase()] = l.substring(sep + 2);
            });
            resolve({ status, headers: resHeaders, data: body });
        });
        socket.on('error', reject);
    });
}

async function s4Get(path) {
    const res = await s4Request('GET', path);
    if (res.status !== 200) throw new Error(`S4 GET ${path} returned ${res.status}: ${res.data.substring(0, 200)}`);
    // Handle chunked transfer encoding
    let body = res.data;
    if ((res.headers['transfer-encoding'] || '').includes('chunked')) {
        let decoded = '';
        let i = 0;
        while (i < body.length) {
            const lineEnd = body.indexOf('\r\n', i);
            if (lineEnd === -1) break;
            const chunkSize = parseInt(body.substring(i, lineEnd), 16);
            if (isNaN(chunkSize) || chunkSize === 0) break;
            decoded += body.substring(lineEnd + 2, lineEnd + 2 + chunkSize);
            i = lineEnd + 2 + chunkSize + 2;
        }
        body = decoded;
    }
    return JSON.parse(body);
}

function statusText(status) {
    if (!status || status.trim() === '') return 'Not Relevant';
    if (status === 'A') return 'Not yet processed';
    if (status === 'B') return 'Partially processed';
    if (status === 'C') return 'Completely processed';
    return status;
}

function podStatusCriticality(status) {
    if (!status || status.trim() === '') return 0;
    if (status === 'A') return 2;
    if (status === 'B') return 1;
    if (status === 'C') return 3;
    return 0;
}

function goodsMovementStatusCriticality(status) {
    if (!status || status.trim() === '') return 2;
    if (status === 'C') return 3;
    if (status === 'B') return 1;
    return 0;
}

function parseDate(val) {
    if (!val) return null;
    const ms = String(val).match(/\/Date\((\d+)\)\//);
    if (ms) return new Date(parseInt(ms[1])).toISOString().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}/.test(String(val))) return String(val).slice(0, 10);
    return null;
}

function parseTime(val) {
    if (!val) return null;
    const m = String(val).match(/PT(\d+)H(\d+)M(\d+)S/);
    if (m) return `${m[1].padStart(2, '0')}:${m[2].padStart(2, '0')}:${m[3].padStart(2, '0')}`;
    if (/^\d{2}:\d{2}(:\d{2})?$/.test(String(val))) return String(val).length === 5 ? `${val}:00` : String(val).slice(0, 8);
    return null;
}

function calcDiff(item) {
    item.qtyDiffnSalesUn = Math.round(((item.actualDeliveryQuantity || 0) - (item.podQuantity || 0)) * 1000) / 1000;
}


// ─── S/4 Sync (rate-limited to once per 5 min) ───────────────────────────────

let lastSyncAt = 0;
const SYNC_TTL = 300_000;

async function fetchTvpodData(deliveryDocument, deliveryDocumentItem) {
    try {
        const data = await s4Get(
            `/sap/opu/odata/sap/ZAPISD_TVPOD_READ_V2_SRV/TvpodResultSet(Vbeln='${deliveryDocument}',Posnr='${deliveryDocumentItem}')?$format=json`
        );
        return data?.d ?? data;
    } catch (e) {
        console.warn(`[POD] TVPOD fetch failed for ${deliveryDocument}/${deliveryDocumentItem}:`, e.message);
        return null;
    }
}

async function syncFromS4() {
    const now = Date.now();
    if (now - lastSyncAt < SYNC_TTL) return;
    lastSyncAt = now;

    const itemFilter = encodeURIComponent("GoodsMovementStatus eq 'C' and ProofOfDeliveryStatus ne 'C' and ProofOfDeliveryRelevanceCode eq 'A'");
    const itemData   = await s4Get(`/sap/opu/odata/sap/API_OUTBOUND_DELIVERY_SRV;v=0002/A_OutbDeliveryItem?$filter=${itemFilter}&$format=json`);
    const results    = itemData?.d?.results ?? itemData?.value ?? [];
    if (!results.length) return;

    const deliveryDocs = [...new Set(results.map(r => r.DeliveryDocument))];
    const hdrFilter    = encodeURIComponent(deliveryDocs.map(d => `DeliveryDocument eq '${d}'`).join(' or '));
    const hdrData      = await s4Get(`/sap/opu/odata/sap/API_OUTBOUND_DELIVERY_SRV;v=0002/A_OutbDeliveryHeader?$filter=${hdrFilter}&$format=json`);
    const hdrResults   = hdrData?.d?.results ?? hdrData?.value ?? [];
    const s4HdrMap     = new Map(hdrResults.map(h => [h.DeliveryDocument, h]));

    const localHeaders    = await SELECT.from(DH).columns('deliveryDocument', 'podDate', 'podTime');
    const localHeaderMap  = new Map(localHeaders.map(r => [r.deliveryDocument, r]));
    const localItems      = await SELECT.from(DI).columns('deliveryDocument', 'deliveryDocumentItem', 'podQuantity', 'podReasonCode');
    const localItemMap    = new Map(localItems.map(r => [`${r.deliveryDocument}|${r.deliveryDocumentItem}`, r]));

    const headerMap = new Map();
    for (const item of results) {
        if (headerMap.has(item.DeliveryDocument)) continue;
        const hdr       = s4HdrMap.get(item.DeliveryDocument) || {};
        const localHdr  = localHeaderMap.get(item.DeliveryDocument);
        const s4PodDate = parseDate(hdr.ProofOfDeliveryDate);
        const s4PodTime = parseTime(hdr.ProofOfDeliveryTime);
        headerMap.set(item.DeliveryDocument, {
            deliveryDocument:               item.DeliveryDocument,
            salesOrganization:              hdr.SalesOrganization                ?? '',
            deliveryDate:                   parseDate(hdr.PlannedGoodsIssueDate ?? hdr.ActualGoodsMovementDate ?? hdr.DeliveryDate),
            documentDate:                   parseDate(hdr.DocumentDate),
            shipToParty:                    hdr.ShipToParty                      ?? '',
            shipToPartyName:                hdr.ShipToPartyName                  ?? hdr.ShipToPartyFullName ?? '',
            shippingPoint:                  hdr.ShippingPoint                    ?? '',
            overallPodStatus:               hdr.OverallProofOfDeliveryStatus     ?? '',
            podStatusCriticality:           podStatusCriticality(hdr.OverallProofOfDeliveryStatus),
            actualGoodsMvmtDate:            parseDate(hdr.ActualGoodsMovementDate ?? hdr.ActualGoodsMvmtDate),
            goodsMovementStatus:            hdr.OverallGoodsMovementStatus      ?? '',
            goodsMovementStatusCriticality: goodsMovementStatusCriticality(hdr.OverallGoodsMovementStatus),
            goodsMovementStatusText:        statusText(hdr.OverallGoodsMovementStatus),
            overallPodStatusText:           statusText(hdr.OverallProofOfDeliveryStatus),
            podDate:                        s4PodDate ?? localHdr?.podDate ?? null,
            podTime:                        s4PodTime ?? localHdr?.podTime ?? null,
            isEditable:                     (hdr.OverallProofOfDeliveryStatus ?? '') !== 'C',
            podCompleted:                   (hdr.OverallProofOfDeliveryStatus ?? '') === 'C',
        });
    }

    const itemsToUpsert = results.map(item => {
        const localItem    = localItemMap.get(`${item.DeliveryDocument}|${item.DeliveryDocumentItem}`);
        const actualQty    = parseFloat(item.ActualDeliveryQuantity) || 0;
        const podQty       = localItem?.podQuantity ?? actualQty;
        const s4ReasonCode = item.ProofOfDeliveryReasonCode ?? '';
        return {
            deliveryDocument:       item.DeliveryDocument,
            deliveryDocumentItem:   item.DeliveryDocumentItem,
            salesOrder:             item.SalesOrder               ?? item.ReferenceSDDocument ?? '',
            material:               item.Material                 ?? '',
            itemText:               item.DeliveryDocumentItemText ?? '',
            actualDeliveryQuantity: actualQty,
            deliveryQuantityUnit:   item.DeliveryQuantityUnit     ?? '',
            podRelevanceCode:       item.ProofOfDeliveryRelevanceCode ?? '',
            podStatus:              item.ProofOfDeliveryStatus    ?? '',
            goodsMovementStatus:    item.GoodsMovementStatus      ?? '',
            actualGoodsMvmtDate:    parseDate(item.ActualGoodsMvmtDate),
            podQuantity:            podQty,
            podQuantityUnit:        item.DeliveryQuantityUnit     ?? '',
            podReasonCode:          localItem?.podReasonCode      ?? s4ReasonCode,
            qtyDiffnSalesUn:        Math.round((actualQty - podQty) * 1000) / 1000,
        };
    });

    await UPSERT.into(DH).entries([...headerMap.values()]);
    await UPSERT.into(DI).entries(itemsToUpsert);
    console.log(`[POD] Synced ${headerMap.size} headers, ${itemsToUpsert.length} items from S/4`);
}

// ─── Service ──────────────────────────────────────────────────────────────────

module.exports = cds.service.impl(async function () {

    this.before('READ', 'DeliveryHeaders', async (req) => {
        try { await syncFromS4(); }
        catch (err) { console.error('[POD] S/4 sync failed:', err.message); }
    });

    this.before('draftEdit', 'DeliveryHeaders', async (req) => {
        const { deliveryDocument } = req.params[0];
        const header = await SELECT.one.from(DH).columns('overallPodStatus').where({ deliveryDocument });
        if (header?.overallPodStatus === 'C')
            req.error(403, 'This delivery has been completely processed and cannot be edited.');
    });

    this.after('EDIT', 'DeliveryHeaders', async (draft) => {
        if (!draft?.deliveryDocument) return;
        if (draft.overallPodStatus === 'C') return;
        const now     = new Date();
        const podDate = now.toISOString().slice(0, 10);
        const podTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
        draft.podDate = podDate;
        draft.podTime = podTime;
        await UPDATE('PODService.DeliveryHeaders.drafts').set({ podDate, podTime }).where({ deliveryDocument: draft.deliveryDocument });
    });

    this.after('READ', 'DeliveryHeaders', (results) => {
        const headers = Array.isArray(results) ? results : results ? [results] : [];
        for (const h of headers) {
            h.isEditable   = h.overallPodStatus !== 'C';
            h.podCompleted = h.overallPodStatus === 'C';
            for (const item of h.deliveryItems || []) calcDiff(item);
        }
    });

    this.after('READ', 'DeliveryItems', async (results) => {
        const items = Array.isArray(results) ? results : results ? [results] : [];
        for (const item of items) {
            calcDiff(item);
            if (item.podStatus === 'C' && item.deliveryDocument && item.deliveryDocumentItem) {
                const tvpod = await fetchTvpodData(item.deliveryDocument, item.deliveryDocumentItem);
                if (tvpod) {
                    item.podQuantity   = tvpod.Podmg  ?? tvpod.podmg  ?? item.podQuantity;
                    item.podReasonCode = tvpod.Grund  ?? tvpod.grund  ?? item.podReasonCode;
                }
            }
        }
    });

    this.after('UPDATE', 'DeliveryItems', async (item) => {
        if (!item?.deliveryDocument || !item?.deliveryDocumentItem) return;
        const draft = await SELECT.one.from('PODService.DeliveryItems.drafts')
            .columns('actualDeliveryQuantity', 'podQuantity', 'podReasonCode')
            .where({ deliveryDocument: item.deliveryDocument, deliveryDocumentItem: item.deliveryDocumentItem });
        if (!draft) return;
        const diff      = (draft.actualDeliveryQuantity || 0) - (draft.podQuantity || 0);
        const autoCode  = diff > 0 ? 'DFG1' : diff < 0 ? 'DFG2' : '';
        const isDefault = !draft.podReasonCode || draft.podReasonCode === 'DFG1' || draft.podReasonCode === 'DFG2';
        if (autoCode && isDefault) {
            await UPDATE('PODService.DeliveryItems.drafts')
                .set({ podReasonCode: autoCode })
                .where({ deliveryDocument: item.deliveryDocument, deliveryDocumentItem: item.deliveryDocumentItem });
            item.podReasonCode = autoCode;
        }
    });

    this.on('submitPOD', 'DeliveryHeaders', async (req) => {
        const { deliveryDocument } = req.params[0];

        const header = await SELECT.one.from(DH).where({ deliveryDocument });
        const items  = await SELECT.from(DI).where({ deliveryDocument });

        if (!items?.length) { req.error(400, 'No delivery items found'); return; }

        for (const item of items) {
            if (item.podQuantity == null) { req.error(400, `Item ${item.deliveryDocumentItem}: POD Quantity is required`); return; }
            if (!item.podReasonCode?.trim()) { req.error(400, `Item ${item.deliveryDocumentItem}: POD Reason Code is required`); return; }
        }

        const podDate = header?.podDate || new Date().toISOString().slice(0, 10);
        const podTime = header?.podTime;

        // Fetch CSRF token
        let csrfToken = '';
        try {
            const csrfRes = await s4Request('GET', `/sap/opu/odata/sap/API_OUTBOUND_DELIVERY_SRV;v=0002/A_OutbDeliveryHeader?$top=0&$format=json`, {
                headers: { 'x-csrf-token': 'fetch' }
            });
            csrfToken = csrfRes.headers['x-csrf-token'] ?? '';
            console.log('[POD] CSRF token:', csrfToken ? 'present' : 'missing');
        } catch (e) {
            console.warn('[POD] CSRF fetch failed:', e.message);
        }

        const soapEndpoint = `/sap/bc/srt/xip/sap/proofofdeliveryrequest_in/${SAP_CLIENT}/zproofofdeliveryrequest_in/zproofofdeliveryrequest_in_bind`;
        const wsaAction    = 'http://sap.com/xi/EDI/Supplier/ProofOfDeliveryRequest_In/ProofOfDeliveryRequest_InRequest';
        const wsrmNs       = 'http://schemas.xmlsoap.org/ws/2005/02/rm';
        const wsaNs        = 'http://schemas.xmlsoap.org/ws/2004/08/addressing';
        const wsaAnonymous = 'http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous';

        // Step 1: WS-RM CreateSequence handshake
        const csReqId = `urn:uuid:${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const createSeqXml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:wsa="${wsaNs}"
                  xmlns:wsrm="${wsrmNs}">
    <soapenv:Header>
        <wsa:MessageID>${csReqId}</wsa:MessageID>
        <wsa:Action>http://schemas.xmlsoap.org/ws/2005/02/rm/CreateSequence</wsa:Action>
        <wsa:To>${wsaAnonymous}</wsa:To>
    </soapenv:Header>
    <soapenv:Body>
        <wsrm:CreateSequence>
            <wsrm:AcksTo><wsa:Address>${wsaAnonymous}</wsa:Address></wsrm:AcksTo>
        </wsrm:CreateSequence>
    </soapenv:Body>
</soapenv:Envelope>`;

        const csResp = await s4Request('POST', soapEndpoint, {
            headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://schemas.xmlsoap.org/ws/2005/02/rm/CreateSequence', 'x-csrf-token': csrfToken },
            body: createSeqXml
        });
        console.log('[POD] CreateSequence status:', csResp.status, csResp.data?.substring?.(0, 300));

        const seqIdMatch = csResp.data?.match(/<[^>]*:?Identifier[^>]*>([^<]+)<\/[^>]*:?Identifier>/);
        if (!seqIdMatch) {
            req.error(500, `POD submission failed: could not obtain WS-RM sequence. Response: ${csResp.data?.substring(0, 200)}`);
            return;
        }
        const sequenceId = seqIdMatch[1];
        console.log('[POD] WS-RM sequence ID:', sequenceId);

        const linesXml = items.map(item => `
            <ProofOfDeliveryItem>
                <DeliveryDocumentItem>${item.deliveryDocumentItem}</DeliveryDocumentItem>
                <ProofOfDeliveryDifferences>
                    <ProofOfDeliveryReason>${item.podReasonCode || ''}</ProofOfDeliveryReason>
                    <ProofOfDeliveryQtyInSlsUnit unitCode="${item.podQuantityUnit}">${item.podQuantity}</ProofOfDeliveryQtyInSlsUnit>
                </ProofOfDeliveryDifferences>
            </ProofOfDeliveryItem>`).join('');

        const msgId  = `urn:uuid:${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const soapXml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:pod="http://sap.com/xi/EDI"
                  xmlns:wsa="${wsaNs}"
                  xmlns:wsrm="${wsrmNs}">
    <soapenv:Header>
        <wsa:MessageID>${msgId}</wsa:MessageID>
        <wsa:Action>${wsaAction}</wsa:Action>
        <wsa:To>${wsaAnonymous}</wsa:To>
        <wsrm:Sequence>
            <wsrm:Identifier>${sequenceId}</wsrm:Identifier>
            <wsrm:MessageNumber>1</wsrm:MessageNumber>
            <wsrm:LastMessage/>
        </wsrm:Sequence>
    </soapenv:Header>
    <soapenv:Body>
        <pod:ProofOfDeliveryRequest>
            <MessageHeader>
                <CreationDateTime>${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</CreationDateTime>
            </MessageHeader>
            <ProofOfDelivery>
                <DeliveryDocument>${deliveryDocument}</DeliveryDocument>
                <ProofOfDeliveryDate>${podDate}</ProofOfDeliveryDate>
                <ProofOfDeliveryTime>${podTime || '00:00:00'}</ProofOfDeliveryTime>
                ${linesXml}
            </ProofOfDelivery>
        </pod:ProofOfDeliveryRequest>
    </soapenv:Body>
</soapenv:Envelope>`;

        const soapResp = await s4Request('POST', soapEndpoint, {
                headers: {
                    'Content-Type': 'text/xml; charset=utf-8',
                    'SOAPAction':   'http://sap.com/xi/EDI/Supplier/ProofOfDeliveryRequest_In/ProofOfDeliveryRequest_InRequest',
                    'x-csrf-token': csrfToken
                },
                body: soapXml
            }
        );

        console.log('[POD] SOAP response status:', soapResp.status, soapResp.data?.substring?.(0, 2000));
        lastSyncAt = 0;
        return { success: true, message: 'POD submitted successfully' };
    });
});
