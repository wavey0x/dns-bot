import { Env, CertificateInfo, DomainState } from "./types";
import * as tls from "node:tls";

export async function checkCertificate(
  domain: string,
  ip: string
): Promise<{ certInfo: CertificateInfo | null; certError: string | null }> {
  return new Promise((resolve) => {
    let errorMsg: string | null = null;
    const socket = tls.connect(
      {
        host: ip,
        servername: domain,
        port: 443,
      },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();

        if (!cert || !cert.subject) {
          resolve({
            certInfo: null,
            certError: "No certificate or subject found",
          });
          return;
        }

        resolve({
          certInfo: {
            issuer: cert.issuer.CN || cert.issuer.O || "Unknown",
            subject: cert.subject.CN || cert.subject.O || "Unknown",
            validFrom: new Date(cert.valid_from).toISOString(),
            validTo: new Date(cert.valid_to).toISOString(),
            fingerprint: cert.fingerprint,
          },
          certError: null,
        });
      }
    );

    socket.on("error", (err) => {
      errorMsg = err?.message || "Unknown TLS error";
      resolve({ certInfo: null, certError: errorMsg });
    });
    socket.setTimeout(5000, () => {
      socket.destroy();
      resolve({ certInfo: null, certError: "TLS connection timed out" });
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
  certCriticalError: string | null;
}> {
  if (ips.length === 0) {
    return {
      isExpected: true,
      certInfo: null,
      certChanged: false,
      certCriticalError: null,
    };
  }

  // Check certificate for the first IP
  const { certInfo, certError } = await checkCertificate(domain, ips[0]);
  if (certError) {
    return {
      isExpected: false,
      certInfo: null,
      certChanged: false,
      certCriticalError: certError,
    };
  }
  if (!certInfo) {
    return {
      isExpected: true,
      certInfo: null,
      certChanged: false,
      certCriticalError: null,
    };
  }

  // If we have a baseline certificate, compare with it
  if (domainState.baselineCert) {
    const isExpected =
      certInfo.fingerprint === domainState.baselineCert.fingerprint;
    return {
      isExpected,
      certInfo,
      certChanged: !isExpected,
      certCriticalError: null,
    };
  }

  // No baseline certificate, this is our first check
  return {
    isExpected: true,
    certInfo,
    certChanged: false,
    certCriticalError: null,
  };
}
