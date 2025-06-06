import { Env, CertificateInfo } from "./types";
import * as tls from "node:tls";

export async function checkCertificate(
  domain: string,
  ip: string
): Promise<CertificateInfo | null> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host: ip,
        servername: domain,
        port: 443,
        rejectUnauthorized: false,
      },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();

        if (!cert || !cert.subject) {
          resolve(null);
          return;
        }

        resolve({
          issuer: cert.issuer.CN || cert.issuer.O || "Unknown",
          subject: cert.subject.CN || cert.subject.O || "Unknown",
          validFrom: new Date(cert.valid_from).toISOString(),
          validTo: new Date(cert.valid_to).toISOString(),
          fingerprint: cert.fingerprint,
        });
      }
    );

    socket.on("error", () => resolve(null));
    socket.setTimeout(5000, () => {
      socket.destroy();
      resolve(null);
    });
  });
}

export async function validateCertificates(
  domain: string,
  newIPs: string[],
  env: Env
): Promise<{
  isExpected: boolean;
  certInfo: CertificateInfo | null;
}> {
  // Get domain state from KV
  const domainStateStr = await env.DNS_KV.get(`dns:${domain}`);
  const domainState = domainStateStr ? JSON.parse(domainStateStr) : null;
  const baselineCert = domainState?.baselineCert || null;

  // Check certificate for first IP (assuming all IPs have same cert)
  const certInfo = await checkCertificate(domain, newIPs[0]);
  if (!certInfo) {
    return { isExpected: false, certInfo: null };
  }

  // If no baseline, this is first check
  if (!baselineCert) {
    return { isExpected: true, certInfo };
  }

  // Compare with baseline
  const isExpected =
    certInfo.issuer === baselineCert.issuer &&
    certInfo.subject === baselineCert.subject &&
    certInfo.fingerprint === baselineCert.fingerprint;

  return { isExpected, certInfo };
}
