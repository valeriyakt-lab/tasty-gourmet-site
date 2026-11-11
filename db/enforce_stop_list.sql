-- Серверный запрет заказов для клиентов из стоп-листа и со «спящей» ссылкой.
-- Запускать в Supabase: проект «Tasty Gourmet Site» → SQL Editor → вставить → Run.
-- Безопасно запускать повторно.

create or replace function public.orders_block_stopped() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.clients c where c.id = new.client_id and c.stop_list) then
    raise exception 'stopped';
  end if;
  if public.client_sleeping(new.client_id) then
    raise exception 'sleeping';
  end if;
  return new;
end $$;

drop trigger if exists orders_block_stopped on public.orders;
create trigger orders_block_stopped before insert on public.orders
  for each row execute function public.orders_block_stopped();
