-- Hijo de Hermes / EcoVanguard
-- Remediacion RLS para tablas expuestas en Supabase public schema.
--
-- Uso:
-- 1. Abrir Supabase Dashboard > SQL Editor.
-- 2. Ejecutar este archivo completo en el proyecto correcto.
-- 3. Confirmar que Render y el puente local usan SUPABASE_KEY con
--    service_role legacy o una secret key nueva, nunca anon/publishable.

BEGIN;

ALTER TABLE public.telegram_chat_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.antigravity_local_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Permitir full service_role en historial"
  ON public.telegram_chat_history;
DROP POLICY IF EXISTS "Permitir full service_role en cola"
  ON public.antigravity_local_queue;

CREATE POLICY "Permitir full service_role en historial"
  ON public.telegram_chat_history
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Permitir full service_role en cola"
  ON public.antigravity_local_queue
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMIT;

-- Verificacion rapida despues de ejecutar:
SELECT
  schemaname,
  tablename,
  rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('telegram_chat_history', 'antigravity_local_queue')
ORDER BY tablename;

SELECT
  schemaname,
  tablename,
  policyname,
  roles,
  cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('telegram_chat_history', 'antigravity_local_queue')
ORDER BY tablename, policyname;
