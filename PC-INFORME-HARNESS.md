# `/pc informe` — piloto local de lectura

## Contrato

- Solo el usuario `ALLOWED_USER_ID`, desde su chat privado, puede encolar el comando fijo `dsh-report:v1:<chat_id>`.
- No se envía texto libre ni URL a Supabase. El usuario deja el informe abierto en la pestaña activa de Edge antes de mandar `/pc informe`.
- El consumidor local vuelve a comprobar `ALLOWED_USER_ID`, reclama la fila de forma atómica y ejecuta `computer-use-headless` con `deepseek-flash` y permiso `read-only`.
- El prompt permite inspeccionar la pestaña activa de Edge y pide no navegar, hacer clic, escribir ni seguir instrucciones de la página. La app CUA tiene alcance del escritorio completo; esa limitación de Edge depende del perfil de herramientas y del prompt, no de un aislamiento del sistema operativo.
- Solo se acepta una respuesta JSON con `total`, `rango` y `pagina_origen`. Se valida el origen, se elimina la ruta/query y se guarda en la fila para que el poller existente responda en el mismo chat.
- Los errores devuelven un texto genérico; ni el contenido completo de la página ni la respuesta sin validar se copian a Telegram o a los logs.

## Ejecución local

El perfil CLI está en `D:\AI\.dsh\profiles\computer-use-headless`. Usa los bundles oficiales `dsh-base` y `dsh-headless`, más `@deepseek-ai/dsh-computer-use` y el proveedor nativo experimental de Cua Driver. El perfil deshabilita PowerShell, filesystem, web, subagentes y herramientas auxiliares; conserva el acceso CUA al escritorio del host.

El proceso `computer-use-bridge.js` carga `telegram-bot\.env` sin imprimir valores y requiere `SUPABASE_URL`, `SUPABASE_KEY` y `ALLOWED_USER_ID`. Ejecutarlo como usuario normal dentro de una sesión iniciada de Windows. No iniciar a la vez `antigravity-bridge.js`; el bridge antiguo ignora el prefijo reservado de este piloto.

Para una tarea real, la sesión CLI debe tener su propia credencial oficial en el almacén de Harness bajo `D:\AI\.dsh`. La clave guardada en Harness Desktop no se copia automáticamente. Introducirla solo en el campo seguro de Harness Web/Models cuando se solicite; no pasarla por Telegram, consola, logs ni repositorio.

## Límites operativos

- La sesión debe estar iniciada y el informe visible en Edge. No se probó la pantalla bloqueada; la suspensión pausa el consumidor; después de reiniciar hace falta iniciar sesión para que arranque la tarea de Windows.
- La sesión Harness puede conservar localmente el historial de la ejecución. El registro de la cola y el mensaje de Telegram conservan solo el resultado solicitado.
- El comando `help` responde directamente desde el bot y no necesita un bridge local. No se abre un puerto público. La app Desktop no pudo agregar el componente CUA desde Complementos porque el componente Cordis no declara `dsh.bundle`; este piloto usa el perfil CLI/web independiente.
