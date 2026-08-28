-- 08-foreign-keys.sql — generated from the recorded foreign-key graph by
-- conformance/fixtures/transform.mjs. Do not edit: re-run the transformer.
--
-- The keys are added here instead of in CREATE TABLE because DSQL rejects a
-- REFERENCES to a table that does not exist yet with 42P01, and upstream
-- declares keys in both directions. ADD CONSTRAINT has to say NOT VALID
-- (0A000 without it), and NOT VALID does not check the rows already in the
-- table, so applying this file after 07-data.sql is both order-independent
-- and immune to the fixture rows the transformer had to thin out. One
-- statement per key: DSQL takes one DDL statement per transaction.
--
-- Every key therefore lands with convalidated = false and stays there —
-- DSQL has no ALTER TABLE ... VALIDATE CONSTRAINT (0A000) — while still
-- being enforced on every write after it is added. Measured 2026-08-28,
-- see docs/plans/dsql-foreign-keys.md.

ALTER TABLE "public"."public_orders" ADD CONSTRAINT "public_orders_consumer_fkey"
  FOREIGN KEY ("consumer") REFERENCES "public"."public_consumers" ("id") NOT VALID;

ALTER TABLE "public"."projects" ADD CONSTRAINT "client"
  FOREIGN KEY ("client_id") REFERENCES "public"."clients" ("id") NOT VALID;

ALTER TABLE "public"."competitors" ADD CONSTRAINT "competitors_sponsor_id_fkey"
  FOREIGN KEY ("sponsor_id") REFERENCES "public"."sponsors" ("id") NOT VALID;

ALTER TABLE "public"."users_projects" ADD CONSTRAINT "users_projects_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") NOT VALID;

ALTER TABLE "public"."users_projects" ADD CONSTRAINT "users_projects_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects" ("id") NOT VALID;

ALTER TABLE "public"."tasks" ADD CONSTRAINT "project"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects" ("id") NOT VALID;

ALTER TABLE "public"."users_tasks" ADD CONSTRAINT "users_tasks_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") NOT VALID;

ALTER TABLE "public"."users_tasks" ADD CONSTRAINT "users_tasks_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "public"."tasks" ("id") NOT VALID;

ALTER TABLE "public"."comments" ADD CONSTRAINT "user"
  FOREIGN KEY ("commenter_id") REFERENCES "public"."users" ("id") NOT VALID;

ALTER TABLE "public"."comments" ADD CONSTRAINT "comments_task_id_fkey"
  FOREIGN KEY ("task_id", "user_id") REFERENCES "public"."users_tasks" ("task_id", "user_id") NOT VALID;

ALTER TABLE "public"."touched_files" ADD CONSTRAINT "fk_users_tasks"
  FOREIGN KEY ("user_id", "task_id") REFERENCES "public"."users_tasks" ("user_id", "task_id") on delete cascade on update cascade NOT VALID;

ALTER TABLE "public"."touched_files" ADD CONSTRAINT "fk_upload"
  FOREIGN KEY ("project_id", "filename") REFERENCES "public"."files" ("project_id", "filename") on delete cascade on update cascade NOT VALID;

ALTER TABLE "private"."article_stars" ADD CONSTRAINT "article"
  FOREIGN KEY ("article_id") REFERENCES "private"."articles" ("id") NOT VALID;

ALTER TABLE "private"."article_stars" ADD CONSTRAINT "user"
  FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") NOT VALID;

ALTER TABLE "public"."ghostBusters" ADD CONSTRAINT "ghostBusters_escapeId_fkey"
  FOREIGN KEY ("escapeId") REFERENCES "public"."Escap3e;" ("so6meIdColumn") NOT VALID;

ALTER TABLE "public"."has_fk" ADD CONSTRAINT "has_fk_fk_fkey"
  FOREIGN KEY ("auto_inc_fk") REFERENCES "public"."auto_incrementing_pk" ("id") NOT VALID;

ALTER TABLE "public"."has_fk" ADD CONSTRAINT "has_fk_simple_fk_fkey"
  FOREIGN KEY ("simple_fk") REFERENCES "public"."simple_pk" ("k") NOT VALID;

ALTER TABLE "public"."orders" ADD CONSTRAINT "billing"
  FOREIGN KEY ("billing_address_id") REFERENCES "public"."addresses" ("id") NOT VALID;

ALTER TABLE "public"."orders" ADD CONSTRAINT "shipping"
  FOREIGN KEY ("shipping_address_id") REFERENCES "public"."addresses" ("id") NOT VALID;

ALTER TABLE "public"."child_entities" ADD CONSTRAINT "child_entities_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "public"."entities" ("id") NOT VALID;

ALTER TABLE "public"."grandchild_entities" ADD CONSTRAINT "grandchild_entities_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "public"."child_entities" ("id") NOT VALID;

ALTER TABLE "public"."descendant" ADD CONSTRAINT "descendant_being_fkey"
  FOREIGN KEY ("being") REFERENCES "public"."being" ("being") NOT VALID;

ALTER TABLE "public"."being_part" ADD CONSTRAINT "being_part_being_fkey"
  FOREIGN KEY ("being") REFERENCES "public"."being" ("being") NOT VALID;

ALTER TABLE "public"."being_part" ADD CONSTRAINT "being_part_part_fkey"
  FOREIGN KEY ("part") REFERENCES "public"."part" ("part") NOT VALID;

ALTER TABLE "public"."family_tree" ADD CONSTRAINT "pptr"
  FOREIGN KEY ("parent") REFERENCES "public"."family_tree" ("id") NOT VALID;

ALTER TABLE "public"."organizations" ADD CONSTRAINT "organizations_referee_fkey"
  FOREIGN KEY ("referee") REFERENCES "public"."organizations" ("id") NOT VALID;

ALTER TABLE "public"."organizations" ADD CONSTRAINT "organizations_auditor_fkey"
  FOREIGN KEY ("auditor") REFERENCES "public"."organizations" ("id") NOT VALID;

ALTER TABLE "public"."organizations" ADD CONSTRAINT "manager"
  FOREIGN KEY ("manager_id") REFERENCES "public"."managers" ("id") NOT VALID;

ALTER TABLE "private"."books" ADD CONSTRAINT "books_author_id_fkey"
  FOREIGN KEY ("author_id") REFERENCES "private"."authors" ("id") NOT VALID;

ALTER TABLE "private"."books" ADD CONSTRAINT "books_first_publisher_id_fkey"
  FOREIGN KEY ("first_publisher_id") REFERENCES "private"."publishers" ("id") NOT VALID;

ALTER TABLE "public"."message" ADD CONSTRAINT "message_sender_fkey"
  FOREIGN KEY ("sender") REFERENCES "public"."person" ("id") NOT VALID;

ALTER TABLE "public"."message" ADD CONSTRAINT "message_recipient_fkey"
  FOREIGN KEY ("recipient") REFERENCES "public"."person" ("id") NOT VALID;

ALTER TABLE "public"."zone" ADD CONSTRAINT "zone_space_id_fkey"
  FOREIGN KEY ("space_id") REFERENCES "public"."space" ("id") NOT VALID;

ALTER TABLE "public"."bar" ADD CONSTRAINT "bar_fooId_fkey"
  FOREIGN KEY ("fooId") REFERENCES "public"."Foo" ("id") NOT VALID;

ALTER TABLE "public"."contract" ADD CONSTRAINT "contract_last_name_id_first_name_birth_date_fkey"
  FOREIGN KEY ("last_name", "id", "first_name", "birth_date") REFERENCES "private"."player" ("last_name", "id", "first_name", "birth_date") NOT VALID;

ALTER TABLE "public"."web_content" ADD CONSTRAINT "web_content_p_web_id_fkey"
  FOREIGN KEY ("p_web_id") REFERENCES "public"."web_content" ("id") NOT VALID;

ALTER TABLE "private"."referrals" ADD CONSTRAINT "referrals_link_fkey"
  FOREIGN KEY ("link") REFERENCES "private"."pages" ("link") NOT VALID;

ALTER TABLE "public"."sites" ADD CONSTRAINT "main_project"
  FOREIGN KEY ("main_project_id") REFERENCES "public"."big_projects" ("big_project_id") NOT VALID;

ALTER TABLE "public"."jobs" ADD CONSTRAINT "jobs_site_id_fkey"
  FOREIGN KEY ("site_id") REFERENCES "public"."sites" ("site_id") NOT VALID;

ALTER TABLE "public"."jobs" ADD CONSTRAINT "jobs_big_project_id_fkey"
  FOREIGN KEY ("big_project_id") REFERENCES "public"."big_projects" ("big_project_id") NOT VALID;

ALTER TABLE "public"."whatev_jobs" ADD CONSTRAINT "whatev_jobs_site_id_1_fkey"
  FOREIGN KEY ("site_id_1") REFERENCES "public"."whatev_sites" ("id") NOT VALID;

ALTER TABLE "public"."whatev_jobs" ADD CONSTRAINT "whatev_jobs_project_id_1_fkey"
  FOREIGN KEY ("project_id_1") REFERENCES "public"."whatev_projects" ("id") NOT VALID;

ALTER TABLE "public"."whatev_jobs" ADD CONSTRAINT "whatev_jobs_site_id_2_fkey"
  FOREIGN KEY ("site_id_2") REFERENCES "public"."whatev_sites" ("id") NOT VALID;

ALTER TABLE "public"."whatev_jobs" ADD CONSTRAINT "whatev_jobs_project_id_2_fkey"
  FOREIGN KEY ("project_id_2") REFERENCES "public"."whatev_projects" ("id") NOT VALID;

ALTER TABLE "public"."departments" ADD CONSTRAINT "departments_head_id_fkey"
  FOREIGN KEY ("head_id") REFERENCES "public"."agents" ("id") NOT VALID;

ALTER TABLE "public"."agents" ADD CONSTRAINT "agents_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "public"."departments" ("id") NOT VALID;

ALTER TABLE "public"."activities" ADD CONSTRAINT "schedule"
  FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules" ("id") NOT VALID;

ALTER TABLE "public"."unit_workdays" ADD CONSTRAINT "fst_shift"
  FOREIGN KEY ("fst_shift_activity_id", "fst_shift_schedule_id") REFERENCES "public"."activities" ("id", "schedule_id") NOT VALID;

ALTER TABLE "public"."unit_workdays" ADD CONSTRAINT "snd_shift"
  FOREIGN KEY ("snd_shift_activity_id", "snd_shift_schedule_id") REFERENCES "public"."activities" ("id", "schedule_id") NOT VALID;

ALTER TABLE "v1"."children" ADD CONSTRAINT "parent"
  FOREIGN KEY ("parent_id") REFERENCES "v1"."parents" ("id") NOT VALID;

ALTER TABLE "v2"."children" ADD CONSTRAINT "parent"
  FOREIGN KEY ("parent_id") REFERENCES "v2"."parents" ("id") NOT VALID;

ALTER TABLE "private"."label_screen" ADD CONSTRAINT "label_screen_label_id_fkey"
  FOREIGN KEY ("label_id") REFERENCES "private"."labels" ("id") on update cascade on delete cascade NOT VALID;

ALTER TABLE "private"."label_screen" ADD CONSTRAINT "label_screen_screen_id_fkey"
  FOREIGN KEY ("screen_id") REFERENCES "private"."screens" ("id") on update cascade on delete cascade NOT VALID;

ALTER TABLE "private"."personnages" ADD CONSTRAINT "personnages_film_id_fkey"
  FOREIGN KEY ("film_id") REFERENCES "private"."films" ("id") not deferrable NOT VALID;

ALTER TABLE "private"."personnages" ADD CONSTRAINT "personnages_role_id_fkey"
  FOREIGN KEY ("role_id") REFERENCES "private"."actors" ("id") not deferrable NOT VALID;

ALTER TABLE "private"."junction" ADD CONSTRAINT "junction_end_1_id_fkey"
  FOREIGN KEY ("end_1_id") REFERENCES "public"."end_1" ("id") on update cascade on delete cascade NOT VALID;

ALTER TABLE "private"."junction" ADD CONSTRAINT "junction_end_2_id_fkey"
  FOREIGN KEY ("end_2_id") REFERENCES "public"."end_2" ("id") on update cascade on delete cascade NOT VALID;

ALTER TABLE "private"."rollen" ADD CONSTRAINT "rollen_film_id_fkey"
  FOREIGN KEY ("film_id") REFERENCES "public"."filme" ("id") NOT VALID;

ALTER TABLE "private"."rollen" ADD CONSTRAINT "rollen_rolle_id_fkey"
  FOREIGN KEY ("rolle_id") REFERENCES "public"."schauspieler" ("id") NOT VALID;

ALTER TABLE "public"."car_racers" ADD CONSTRAINT "car_racers_car_model_name_car_model_year_fkey"
  FOREIGN KEY ("car_model_name", "car_model_year") REFERENCES "public"."car_models" ("name", "year") NOT VALID;

ALTER TABLE "public"."products_suppliers" ADD CONSTRAINT "products_suppliers_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "public"."products" ("id") NOT VALID;

ALTER TABLE "public"."products_suppliers" ADD CONSTRAINT "products_suppliers_supplier_id_fkey"
  FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers" ("id") NOT VALID;

ALTER TABLE "public"."suppliers_trade_unions" ADD CONSTRAINT "suppliers_trade_unions_supplier_id_fkey"
  FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers" ("id") NOT VALID;

ALTER TABLE "public"."suppliers_trade_unions" ADD CONSTRAINT "suppliers_trade_unions_trade_union_id_fkey"
  FOREIGN KEY ("trade_union_id") REFERENCES "public"."trade_unions" ("id") NOT VALID;

ALTER TABLE "public"."contact" ADD CONSTRAINT "contact_clientid_fkey"
  FOREIGN KEY ("clientid") REFERENCES "public"."client" ("id") NOT VALID;

ALTER TABLE "public"."clientinfo" ADD CONSTRAINT "clientinfo_clientid_fkey"
  FOREIGN KEY ("clientid") REFERENCES "public"."client" ("id") NOT VALID;

ALTER TABLE "public"."well" ADD CONSTRAINT "well_parent_well_id_fkey"
  FOREIGN KEY ("parent_well_id") REFERENCES "public"."well" ("well_id") NOT VALID;

ALTER TABLE "public"."well" ADD CONSTRAINT "well_plate_id_fkey"
  FOREIGN KEY ("plate_id") REFERENCES "public"."plate" ("plate_id") NOT VALID;

ALTER TABLE "public"."plate_plan_step" ADD CONSTRAINT "plate_plan_step_from_well_id_fkey"
  FOREIGN KEY ("from_well_id") REFERENCES "public"."well" ("well_id") NOT VALID;

ALTER TABLE "public"."plate_plan_step" ADD CONSTRAINT "plate_plan_step_to_plate_id_fkey"
  FOREIGN KEY ("to_plate_id") REFERENCES "public"."plate" ("plate_id") NOT VALID;

ALTER TABLE "public"."plate_plan_step" ADD CONSTRAINT "plate_plan_step_to_well_id_fkey"
  FOREIGN KEY ("to_well_id") REFERENCES "public"."well" ("well_id") NOT VALID;

ALTER TABLE "private"."internal_job" ADD CONSTRAINT "parent_fk"
  FOREIGN KEY ("parent_id") REFERENCES "private"."internal_job" ("id") NOT VALID;

ALTER TABLE "public"."adaptation_notifications" ADD CONSTRAINT "adaptation_notifications_series_fkey"
  FOREIGN KEY ("series") REFERENCES "public"."series" ("id") NOT VALID;

ALTER TABLE "public"."test" ADD CONSTRAINT "parent_test"
  FOREIGN KEY ("parent_id") REFERENCES "public"."test" ("id") NOT VALID;

ALTER TABLE "public"."shop_bles" ADD CONSTRAINT "shop_bles_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "public"."shops" ("id") NOT VALID;

ALTER TABLE "SPECIAL ""@/\#~_-"."names" ADD CONSTRAINT "names_language_id_fkey"
  FOREIGN KEY ("language_id") REFERENCES "SPECIAL ""@/\#~_-"."languages" ("id") NOT VALID;

ALTER TABLE "public"."videogames" ADD CONSTRAINT "videogames_designer_id_fkey"
  FOREIGN KEY ("designer_id") REFERENCES "public"."designers" ("id") NOT VALID;

ALTER TABLE "public"."students_info" ADD CONSTRAINT "students_info_code_id_fkey"
  FOREIGN KEY ("code", "id") REFERENCES "public"."students" ("code", "id") on delete cascade NOT VALID;

ALTER TABLE "public"."capital" ADD CONSTRAINT "capital_country_id_fkey"
  FOREIGN KEY ("country_id") REFERENCES "public"."country" ("id") NOT VALID;

ALTER TABLE "public"."first" ADD CONSTRAINT "first_second_id_1_fkey"
  FOREIGN KEY ("second_id_1") REFERENCES "public"."second" ("id") NOT VALID;

ALTER TABLE "public"."first" ADD CONSTRAINT "first_second_id_2_fkey"
  FOREIGN KEY ("second_id_2") REFERENCES "public"."second" ("id") NOT VALID;

ALTER TABLE "public"."first_1" ADD CONSTRAINT "first_1_second_id_1_fkey"
  FOREIGN KEY ("second_id_1") REFERENCES "public"."second" ("id") NOT VALID;

ALTER TABLE "public"."first_1" ADD CONSTRAINT "first_1_second_id_2_fkey"
  FOREIGN KEY ("second_id_2") REFERENCES "public"."second" ("id") NOT VALID;

ALTER TABLE "public"."janedoe" ADD CONSTRAINT "janedoe_baz_id_fkey"
  FOREIGN KEY ("baz_id") REFERENCES "public"."baz" ("baz_id") NOT VALID;

ALTER TABLE "public"."johnsmith" ADD CONSTRAINT "johnsmith_fee_id_fkey"
  FOREIGN KEY ("fee_id") REFERENCES "public"."fee" ("fee_id") NOT VALID;

ALTER TABLE "public"."johnsmith" ADD CONSTRAINT "johnsmith_baz_id_fkey"
  FOREIGN KEY ("baz_id") REFERENCES "public"."baz" ("baz_id") NOT VALID;

ALTER TABLE "public"."b" ADD CONSTRAINT "b_c1_c2_fkey"
  FOREIGN KEY ("c1", "c2") REFERENCES "public"."a" ("c1", "c2") NOT VALID;

ALTER TABLE "public"."i2459_simple_t2" ADD CONSTRAINT "i2459_simple_t2_t1_id_fkey"
  FOREIGN KEY ("t1_id") REFERENCES "public"."i2459_simple_t1" ("id") NOT VALID;

ALTER TABLE "public"."i2459_composite_t2" ADD CONSTRAINT "i2459_composite_t2_t1_a_t1_b_fkey"
  FOREIGN KEY ("t1_a", "t1_b") REFERENCES "public"."i2459_composite_t1" ("a", "b") NOT VALID;

ALTER TABLE "public"."i2459_self_t" ADD CONSTRAINT "i2459_self_t_parent_fkey"
  FOREIGN KEY ("parent") REFERENCES "public"."i2459_self_t" ("id") NOT VALID;

ALTER TABLE "public"."tb" ADD CONSTRAINT "tb_b1_fkey"
  FOREIGN KEY ("b1") REFERENCES "public"."ta" ("a1") NOT VALID;

ALTER TABLE "public"."tb" ADD CONSTRAINT "tb_b1_b2_fkey"
  FOREIGN KEY ("b1", "b2") REFERENCES "public"."ta" ("a1", "a2") NOT VALID;

ALTER TABLE "public"."trash_details" ADD CONSTRAINT "trash_details_id_fkey"
  FOREIGN KEY ("id") REFERENCES "public"."trash" ("id") NOT VALID;

ALTER TABLE "public"."group_yard" ADD CONSTRAINT "group_yard_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "public"."groups" ("name") NOT VALID;

ALTER TABLE "public"."group_yard" ADD CONSTRAINT "group_yard_yard_id_fkey"
  FOREIGN KEY ("yard_id") REFERENCES "public"."yards" ("id") NOT VALID;

ALTER TABLE "public"."subscriptions" ADD CONSTRAINT "subscriptions_subscriber_fkey"
  FOREIGN KEY ("subscriber") REFERENCES "public"."posters" ("id") NOT VALID;

ALTER TABLE "public"."subscriptions" ADD CONSTRAINT "subscriptions_subscribed_fkey"
  FOREIGN KEY ("subscribed") REFERENCES "public"."posters" ("id") NOT VALID;

ALTER TABLE "public"."datarep_next_two_todos" ADD CONSTRAINT "datarep_next_two_todos_first_item_id_fkey"
  FOREIGN KEY ("first_item_id") REFERENCES "public"."datarep_todos" ("id") NOT VALID;

ALTER TABLE "public"."datarep_next_two_todos" ADD CONSTRAINT "datarep_next_two_todos_second_item_id_fkey"
  FOREIGN KEY ("second_item_id") REFERENCES "public"."datarep_todos" ("id") NOT VALID;

ALTER TABLE "public"."user_friend" ADD CONSTRAINT "user_friend_user1_fkey"
  FOREIGN KEY ("user1") REFERENCES "public"."profiles" ("id") NOT VALID;

ALTER TABLE "public"."user_friend" ADD CONSTRAINT "user_friend_user2_fkey"
  FOREIGN KEY ("user2") REFERENCES "public"."profiles" ("id") NOT VALID;

ALTER TABLE "public"."tournaments" ADD CONSTRAINT "tournaments_status_fkey"
  FOREIGN KEY ("status") REFERENCES "public"."status" ("id") NOT VALID;

ALTER TABLE "public"."table_b" ADD CONSTRAINT "table_b_table_a_id_fkey"
  FOREIGN KEY ("table_a_id") REFERENCES "public"."table_a" ("id") NOT VALID;

ALTER TABLE "public"."project_invoices" ADD CONSTRAINT "project_invoices_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects" ("id") NOT VALID;

ALTER TABLE "public"."budget_expenses" ADD CONSTRAINT "budget_expenses_budget_category_id_fkey"
  FOREIGN KEY ("budget_category_id") REFERENCES "public"."budget_categories" ("id") NOT VALID;

ALTER TABLE "public"."processes" ADD CONSTRAINT "processes_factory_id_fkey"
  FOREIGN KEY ("factory_id") REFERENCES "public"."factories" ("id") NOT VALID;

ALTER TABLE "public"."processes" ADD CONSTRAINT "processes_category_id_fkey"
  FOREIGN KEY ("category_id") REFERENCES "public"."process_categories" ("id") NOT VALID;

ALTER TABLE "public"."process_costs" ADD CONSTRAINT "process_costs_process_id_fkey"
  FOREIGN KEY ("process_id") REFERENCES "public"."processes" ("id") NOT VALID;

ALTER TABLE "public"."process_supervisor" ADD CONSTRAINT "process_supervisor_process_id_fkey"
  FOREIGN KEY ("process_id") REFERENCES "public"."processes" ("id") NOT VALID;

ALTER TABLE "public"."process_supervisor" ADD CONSTRAINT "process_supervisor_supervisor_id_fkey"
  FOREIGN KEY ("supervisor_id") REFERENCES "public"."supervisors" ("id") NOT VALID;

ALTER TABLE "public"."albums" ADD CONSTRAINT "fk_artist"
  FOREIGN KEY ("artist_id") REFERENCES "public"."artists" ("id") ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

ALTER TABLE "public"."process_operator" ADD CONSTRAINT "process_operator_process_id_fkey"
  FOREIGN KEY ("process_id") REFERENCES "public"."processes" ("id") NOT VALID;

ALTER TABLE "public"."process_operator" ADD CONSTRAINT "process_operator_operator_id_fkey"
  FOREIGN KEY ("operator_id") REFERENCES "public"."operators" ("id") NOT VALID;

ALTER TABLE "public"."factory_buildings" ADD CONSTRAINT "factory_buildings_factory_id_fkey"
  FOREIGN KEY ("factory_id") REFERENCES "public"."factories" ("id") NOT VALID;

ALTER TABLE "public"."visits" ADD CONSTRAINT "visits_place_id_fkey"
  FOREIGN KEY ("place_id") REFERENCES "public"."places" ("id") NOT VALID;

