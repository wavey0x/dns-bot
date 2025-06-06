import { Env, CertificateInfo, DomainState } from "./types";
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
  ips: string[],
  domainState: DomainState
): Promise<{
  isExpected: boolean;
  certInfo: CertificateInfo | null;
  certChanged: boolean;
}> {
  if (ips.length === 0) {
    return { isExpected: true, certInfo: null, certChanged: false };
  }

  // Check certificate for the first IP
  const certInfo = await checkCertificate(domain, ips[0]);
  if (!certInfo) {
    return { isExpected: true, certInfo: null, certChanged: false };
  }

  // If we have a baseline certificate, compare with it
  if (domainState.baselineCert) {
    const isExpected =
      certInfo.fingerprint === domainState.baselineCert.fingerprint;
    return {
      isExpected,
      certInfo,
      certChanged: !isExpected,
    };
  }

  // No baseline certificate, this is our first check
  return { isExpected: true, certInfo, certChanged: false };
}
