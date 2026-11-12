# AntiCrack (capa nativa del motor de ofuscacion)

Estos dos modulos en C# son la capa anti-debug y anti-hook para el build nativo del
motor de ofuscacion (la VM). El motor de JavaScript del backend no puede usarlos;
van integrados en el binario nativo al compilarlo.

- `AntiDebug.cs`: deteccion de debuggers (IsDebuggerPresent, NtQueryInformationProcess,
  NtGlobalFlag, hardware breakpoints, parent process, page guard, ventanas de tools, etc.).
- `HooksDetection.cs`: deteccion de hooks inline y de paginas de guarda sobre las APIs
  de kernel32, kernelbase, ntdll, user32 y win32u.

Integracion: en el arranque del binario nativo, llamar a `AntiDebug.AntiDebugAttach()`
y, en los puntos de entrega de codigo, a `HooksDetection.DetectHooks()`. Ante un
positivo el binario debe comportarse como el loader: reportar tamper al servidor y
no entregar el codigo.

Referencia: los fragmentos provienen del archivo abierto AntiCrack_DotNet y se
incluyen tal cual para el build nativo.
