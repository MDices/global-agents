import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface RelayCert {
  key: string;
  cert: string;
  /** SHA-256 do certificado no formato `AA:BB:…` (95 caracteres), o valor que o agente fixa. */
  fingerprint256: string;
}

/**
 * Garante o par `<dataDir>/tls/relay.key|relay.crt` (autoassinado, 10 anos, CN=global-agents-relay).
 * Se os dois existem, só carrega; se faltar algum, gera os dois de novo com `openssl` (sem shell),
 * escrevendo em arquivos temporários e renomeando, para nunca deixar um par pela metade.
 */
export function ensureCert(dataDir: string): RelayCert {
  const tlsDir = join(dataDir, "tls");
  const keyPath = join(tlsDir, "relay.key");
  const certPath = join(tlsDir, "relay.crt");

  if (!existsSync(keyPath) || !existsSync(certPath)) {
    mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
    const tmpKey = `${keyPath}.tmp-${process.pid}`;
    const tmpCert = `${certPath}.tmp-${process.pid}`;
    try {
      execFileSync(
        "openssl",
        ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650", "-subj", "/CN=global-agents-relay",
          "-keyout", tmpKey, "-out", tmpCert],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      chmodSync(tmpKey, 0o600);
      renameSync(tmpKey, keyPath);
      renameSync(tmpCert, certPath);
    } catch (e) {
      rmSync(tmpKey, { force: true });
      rmSync(tmpCert, { force: true });
      const stderr = (e as { stderr?: Buffer }).stderr?.toString("utf8").trim();
      throw new Error(`falha ao gerar o certificado do relay com openssl: ${stderr || (e as Error).message}`);
    }
  }

  const key = readFileSync(keyPath, "utf8");
  const cert = readFileSync(certPath, "utf8");
  return { key, cert, fingerprint256: new X509Certificate(cert).fingerprint256 };
}
