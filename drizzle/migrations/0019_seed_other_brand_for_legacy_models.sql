-- Keep legacy products selectable until an administrator assigns their actual brand/model.
insert into public.product_brands(name) values ('OTHER') on conflict do nothing;
insert into public.product_models(brand_id, name)
select b.id, min(coalesce(nullif(trim(p.model), ''), p.name))
from public.products p
cross join public.product_brands b
where b.name = 'OTHER' and p.brand_id is null
group by b.id, lower(coalesce(nullif(trim(p.model), ''), p.name))
on conflict do nothing;
