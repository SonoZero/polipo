'use strict';

// Durante le stampe USB SonoPrint manda la stampa riga per riga: Windows deve trattarlo come un
// programma in primo piano anche con la finestra nascosta. Priorità alta (non "tempo reale", che
// può bloccare mouse e tastiera), niente modalità efficienza di Windows (EcoQoS) e computer sveglio.

const os = require('os');
const { spawn } = require('child_process');

// aiutante PowerShell: toglie a SonoPrint il risparmio energetico di Windows, tiene sveglio il
// computer e aspetta che SonoPrint chiuda il canale (fine delle stampe, uscita o chiusura improvvisa)
function helperScript(pid, keepAwake) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace SonoPrint -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct Throttling { public uint Version; public uint ControlMask; public uint StateMask; }
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetProcessInformation(IntPtr process, int infoClass, ref Throttling info, int size);
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
'@
function Set-Throttling($h, [uint32]$control) {
  $s = New-Object SonoPrint.Native+Throttling
  $s.Version = 1; $s.ControlMask = $control; $s.StateMask = 0
  [SonoPrint.Native]::SetProcessInformation($h, 4, [ref]$s, 12)
}
# PROCESS_SET_INFORMATION; ProcessPowerThrottling = 4; velocità (1) e risoluzione del timer (4, solo Windows 11)
$h = [SonoPrint.Native]::OpenProcess(0x0200, $false, ${Number(pid)})
if ($h -ne [IntPtr]::Zero) {
  $ok = (Set-Throttling $h 5) -or (Set-Throttling $h 1)
  "efficienza:$ok"
}
${keepAwake ? "# ES_CONTINUOUS | ES_SYSTEM_REQUIRED (0x80000001, scritto in decimale: in PowerShell 0x80000001 è negativo)\n[void][SonoPrint.Native]::SetThreadExecutionState(2147483649)\n'sveglio'" : ''}
[void][Console]::In.ReadToEnd()
if ($h -ne [IntPtr]::Zero) { [void](Set-Throttling $h 0); [void][SonoPrint.Native]::CloseHandle($h) }
`;
}

class PrintGuard {
  /** log: { info, warn } */
  constructor(log) {
    this.log = log;
    this.priority = false;
    this.helper = null;
    this.helperAwake = null;
  }

  /** Applica lo stato voluto: stampe USB in corso e impostazioni. */
  update({ printing, highPriority, preventSleep }) {
    const wantPriority = !!(printing && highPriority);
    if (wantPriority !== this.priority) this._setPriority(wantPriority);
    // l'aiutante serve a tenere sveglio il computer e a togliere la modalità efficienza
    const wantHelper = process.platform === 'win32' && printing && (highPriority || preventSleep);
    if (!wantHelper || (this.helper && this.helperAwake !== !!preventSleep)) this._stopHelper();
    if (wantHelper && !this.helper) this._startHelper(!!preventSleep);
  }

  stop() {
    this.update({ printing: false });
  }

  _setPriority(high) {
    try {
      os.setPriority(process.pid, high ? os.constants.priority.PRIORITY_HIGH : os.constants.priority.PRIORITY_NORMAL);
      this.priority = high;
      this.log.info(high ? 'Priorità alta per le stampe USB' : 'Priorità normale');
    } catch (err) {
      // su Mac serve l'amministratore: si resta alla priorità normale
      this.priority = high;
      this.log.warn('Priorità non cambiata:', err.message);
    }
  }

  _startHelper(keepAwake) {
    const encoded = Buffer.from(helperScript(process.pid, keepAwake), 'utf16le').toString('base64');
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.log.warn('Aiutante per le stampe non avviato:', err.message);
      return;
    }
    this.helper = child;
    this.helperAwake = keepAwake;
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    // quando ha fatto il suo lavoro lo scrive: lo si riporta nel registro
    const report = setTimeout(() => {
      const text = out.replace(/\s+/g, ' ').trim();
      const efficiency = /efficienza:True/.test(text);
      const awake = /sveglio/.test(text);
      if (efficiency || awake) this.log.info(`Stampe USB: ${[efficiency ? 'modalità efficienza di Windows disattivata' : null, awake ? 'computer tenuto sveglio' : null].filter(Boolean).join(', ')}`);
      else if (text) this.log.warn('Aiutante per le stampe:', text.slice(0, 300));
    }, 8000);
    child.on('error', (err) => this.log.warn('Aiutante per le stampe:', err.message));
    child.on('exit', (code) => {
      clearTimeout(report);
      if (this.helper !== child) return;
      // chiuso da solo mentre serviva: si annota il perché
      this.helper = null;
      this.helperAwake = null;
      this.log.warn(`Aiutante per le stampe chiuso (codice ${code}):`, out.replace(/\s+/g, ' ').trim().slice(0, 300));
    });
    child.stdin.on('error', () => {});
  }

  _stopHelper() {
    const child = this.helper;
    if (!child) return;
    this.helper = null;
    this.helperAwake = null;
    // chiudendo il canale l'aiutante rimette il risparmio energetico com'era ed esce
    try { child.stdin.end(); } catch (_) { /* già chiuso */ }
    setTimeout(() => { if (child.exitCode === null) child.kill(); }, 5000).unref();
  }
}

module.exports = { PrintGuard, helperScript };
