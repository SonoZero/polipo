'use strict';

// Firewall di Windows per l'accesso dalla rete: stato delle regole di SonoPrint e aggiunta della
// regola per la rete privata. L'aggiunta passa dalla conferma da amministratore di Windows (UAC).

const { execFile } = require('child_process');

function runPowerShell(script, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(new Error(String(stderr || err.message).trim().split('\n')[0]), { code: err.code }));
      resolve(String(stdout).trim());
    });
  });
}

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Regole in ingresso per l'eseguibile di SonoPrint e tipo delle reti collegate.
 * allowed: c'è una regola che consente la rete privata; blocked: c'è una regola che blocca (vince sempre).
 */
async function firewallStatus(exe) {
  if (process.platform !== 'win32' || !exe) return { supported: false };
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$p = ${quote(exe)}
$rules = @(Get-NetFirewallApplicationFilter | Where-Object { [Environment]::ExpandEnvironmentVariables($_.Program) -ieq $p } | Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' } |
  ForEach-Object { [pscustomobject]@{ name = $_.DisplayName; action = $_.Action.ToString(); profile = $_.Profile.ToString() } })
$nets = @(Get-NetConnectionProfile | ForEach-Object { [pscustomobject]@{ name = $_.Name; alias = $_.InterfaceAlias; category = $_.NetworkCategory.ToString() } })
[pscustomobject]@{ rules = $rules; networks = $nets } | ConvertTo-Json -Depth 4 -Compress`;
  let data;
  try {
    data = JSON.parse(await runPowerShell(script) || '{}');
  } catch (err) {
    return { supported: true, error: 'Non riesco a leggere il firewall di Windows: ' + err.message };
  }
  const rules = [].concat(data.rules || []);
  const networks = [].concat(data.networks || []);
  const covers = (profile, wanted) => /Any/i.test(profile) || new RegExp(wanted, 'i').test(profile);
  return {
    supported: true,
    allowed: rules.some((r) => r.action === 'Allow' && covers(r.profile, 'Private')),
    blocked: rules.some((r) => r.action === 'Block'),
    publicNetworks: networks.filter((n) => n.category === 'Public').map((n) => n.name || n.alias),
    networks,
  };
}

/** Aggiunge la regola "SonoPrint" per la rete privata (e toglie eventuali blocchi), con la conferma di Windows. */
async function allowInFirewall(exe) {
  if (process.platform !== 'win32' || !exe) throw new Error('Il firewall si imposta così solo nella versione installata per Windows.');
  const inner = `
$p = ${quote(exe)}
Get-NetFirewallApplicationFilter | Where-Object { [Environment]::ExpandEnvironmentVariables($_.Program) -ieq $p } | Get-NetFirewallRule | Where-Object { $_.Action -eq 'Block' } | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'SonoPrint' -Description 'SonoPrint: accesso dalla rete di casa' -Direction Inbound -Action Allow -Program $p -Profile Private | Out-Null`;
  const innerEncoded = Buffer.from(inner, 'utf16le').toString('base64');
  const outer = `
try {
  $proc = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${innerEncoded}'
  exit $proc.ExitCode
} catch { exit 1223 }`;
  try {
    await runPowerShell(outer, 120000);
  } catch (err) {
    if (err.code === 1223) throw new Error('Permesso non concesso: la regola del firewall non è stata aggiunta.');
    throw new Error('Non sono riuscito ad aggiungere la regola del firewall: ' + err.message);
  }
  return firewallStatus(exe);
}

module.exports = { firewallStatus, allowInFirewall };
