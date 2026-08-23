-- 07-data.sql — generated from data.sql by conformance/fixtures/transform.mjs
-- Do not edit: re-run the transformer.

-- Sequence state a data-only reload has to restore: CREATE SEQUENCE /
-- GENERATED AS IDENTITY leaves "last value 1, not yet called", and this
-- file is re-applied without 03-schema.sql. The four setvals data.sql
-- carries itself are further down and are not repeated here.
SELECT pg_catalog.setval(pg_get_serial_sequence('items3', 'id'), 1, false);
SELECT pg_catalog.setval(pg_get_serial_sequence('public_consumers', 'id'), 1, false);
SELECT pg_catalog.setval(pg_get_serial_sequence('public_orders', 'id'), 1, false);
SELECT pg_catalog.setval(pg_get_serial_sequence('"public".leak', 'id'), 1, false);
SELECT pg_catalog.setval(pg_get_serial_sequence('big_projects', 'big_project_id'), 1, false);
SELECT pg_catalog.setval(pg_get_serial_sequence('sites', 'site_id'), 1, false);
SELECT pg_catalog.setval(pg_get_serial_sequence('whatev_projects', 'id'), 1, false);
SELECT pg_catalog.setval(pg_get_serial_sequence('whatev_sites', 'id'), 1, false);
SELECT pg_catalog.setval(pg_get_serial_sequence('private.screens', 'id'), 1, false);
SELECT pg_catalog.setval(pg_get_serial_sequence('private.labels', 'id'), 1, false);
SELECT pg_catalog.setval(pg_get_serial_sequence('clientinfo', 'id'), 1, false);
SELECT pg_catalog.setval(pg_get_serial_sequence('"public".channels', 'id'), 1, false);
SELECT pg_catalog.setval(pg_get_serial_sequence('surr_serial_upsert', 'id'), 1, false);
SELECT pg_catalog.setval(pg_get_serial_sequence('surr_gen_default_upsert', 'id'), 1, false);
SELECT pg_catalog.setval(pg_get_serial_sequence('"Surr_Gen_Default_Upsert"', 'id'), 1, false);
SELECT pg_catalog.setval(pg_get_serial_sequence('places', 'id'), 1, false);
SELECT pg_catalog.setval(pg_get_serial_sequence('visits', 'id'), 1, false);
SELECT pg_catalog.setval('callcounter_count', 1, false);

SET search_path = postgrest, pg_catalog;

DELETE FROM auth;

INSERT INTO auth VALUES ('jdoe', 'postgrest_test_author', '1234                                                        ');

SET search_path = private, pg_catalog;

DELETE FROM articles;

INSERT INTO articles VALUES (1, 'No… It''s a thing; it''s like a plan, but with more greatness.', 'diogo');

INSERT INTO articles VALUES (2, 'Stop talking, brain thinking. Hush.', 'diogo');

INSERT INTO articles VALUES (3, 'It''s a fez. I wear a fez now. Fezes are cool.', 'diogo');

SET search_path = "public", pg_catalog;

DELETE FROM users;

INSERT INTO users VALUES (1, 'Angela Martin');

INSERT INTO users VALUES (2, 'Michael Scott');

INSERT INTO users VALUES (3, 'Dwight Schrute');

SET search_path = private, pg_catalog;

DELETE FROM article_stars;

INSERT INTO article_stars VALUES (1, 1, '2015-12-08 04:22:57.472738');

INSERT INTO article_stars VALUES (1, 2, '2015-12-08 04:22:57.472738');

INSERT INTO article_stars VALUES (2, 3, '2015-12-08 04:22:57.472738');

INSERT INTO article_stars VALUES (3, 2, '2015-12-08 04:22:57.472738');

INSERT INTO article_stars VALUES (1, 3, '2015-12-08 04:22:57.472738');

SET search_path = "public", pg_catalog;

DELETE FROM authors_only;

DELETE FROM auto_incrementing_pk;

--
-- Name: auto_incrementing_pk_id_seq; Type: SEQUENCE SET; Schema: test; Owner: -
--

SELECT pg_catalog.setval('auto_incrementing_pk_id_seq', 1, true);

DELETE FROM clients;

INSERT INTO clients VALUES (1, 'Microsoft');

INSERT INTO clients VALUES (2, 'Apple');

DELETE FROM projects;

INSERT INTO projects VALUES (1, 'Windows 7', 1);

INSERT INTO projects VALUES (2, 'Windows 10', 1);

INSERT INTO projects VALUES (3, 'IOS', 2);

INSERT INTO projects VALUES (4, 'OSX', 2);

INSERT INTO projects VALUES (5, 'Orphan', NULL);

DELETE FROM tasks;

INSERT INTO tasks VALUES (1, 'Design w7', 1);

INSERT INTO tasks VALUES (2, 'Code w7', 1);

INSERT INTO tasks VALUES (3, 'Design w10', 2);

INSERT INTO tasks VALUES (4, 'Code w10', 2);

INSERT INTO tasks VALUES (5, 'Design IOS', 3);

INSERT INTO tasks VALUES (6, 'Code IOS', 3);

INSERT INTO tasks VALUES (7, 'Design OSX', 4);

INSERT INTO tasks VALUES (8, 'Code OSX', 4);

DELETE FROM users_tasks;

INSERT INTO users_tasks VALUES (1, 1);

INSERT INTO users_tasks VALUES (1, 2);

INSERT INTO users_tasks VALUES (1, 3);

INSERT INTO users_tasks VALUES (1, 4);

INSERT INTO users_tasks VALUES (2, 5);

INSERT INTO users_tasks VALUES (2, 6);

INSERT INTO users_tasks VALUES (2, 7);

INSERT INTO users_tasks VALUES (3, 1);

INSERT INTO users_tasks VALUES (3, 5);

DELETE FROM comments;

INSERT INTO comments VALUES (1, 1, 2, 6, 'Needs to be delivered ASAP');

DELETE FROM files;

INSERT INTO files VALUES
	 (1, 'command.com', '#include <unix.h>')
	,(1, 'autoexec.bat', '@ECHO OFF')
	,(1, 'io.sys', 'TODO')
	,(2, 'README.md', '# make $$$!')
	,(2, 'marketing.key', '$-$')
	;

DELETE FROM touched_files;

INSERT INTO touched_files VALUES
	 (1, 1, 1, 'command.com')
	,(1, 1, 1, 'autoexec.bat')
	,(1, 1, 2, 'README.md')
	,(3, 1, 1, 'autoexec.bat')
	;

DELETE FROM complex_items;

INSERT INTO complex_items ("id", "name", "settings") VALUES (1, 'One', '{"foo":{"int":1,"bar":"baz"}}');

INSERT INTO complex_items ("id", "name", "settings") VALUES (2, 'Two', '{"foo":{"int":1,"bar":"baz"}}');

INSERT INTO complex_items ("id", "name", "settings", "field-with_sep") VALUES (3, 'Three', '{"foo":{"int":1,"bar":"baz"}}', 3);

DELETE FROM compound_pk;

DELETE FROM simple_pk;

INSERT INTO simple_pk VALUES ('xyyx', 'u');

INSERT INTO simple_pk VALUES ('xYYx', 'v');

DELETE FROM has_fk;

--
-- Name: has_fk_id_seq; Type: SEQUENCE SET; Schema: test; Owner: -
--

SELECT pg_catalog.setval('has_fk_id_seq', 1, false);

DELETE FROM items;

INSERT INTO items VALUES (1);

INSERT INTO items VALUES (2);

INSERT INTO items VALUES (3);

INSERT INTO items VALUES (4);

INSERT INTO items VALUES (5);

INSERT INTO items VALUES (6);

INSERT INTO items VALUES (7);

INSERT INTO items VALUES (8);

INSERT INTO items VALUES (9);

INSERT INTO items VALUES (10);

INSERT INTO items VALUES (11);

INSERT INTO items VALUES (12);

INSERT INTO items VALUES (13);

INSERT INTO items VALUES (14);

INSERT INTO items VALUES (15);

--
-- Name: items_id_seq; Type: SEQUENCE SET; Schema: test; Owner: -
--

SELECT pg_catalog.setval('items_id_seq', 15, true);

DELETE FROM items2;

INSERT INTO items2 VALUES (1);

INSERT INTO items2 VALUES (2);

INSERT INTO items2 VALUES (3);

INSERT INTO items2 VALUES (4);

INSERT INTO items2 VALUES (5);

INSERT INTO items2 VALUES (6);

INSERT INTO items2 VALUES (7);

INSERT INTO items2 VALUES (8);

INSERT INTO items2 VALUES (9);

INSERT INTO items2 VALUES (10);

INSERT INTO items2 VALUES (11);

INSERT INTO items2 VALUES (12);

INSERT INTO items2 VALUES (13);

INSERT INTO items2 VALUES (14);

INSERT INTO items2 VALUES (15);

--
-- Name: items_id_seq; Type: SEQUENCE SET; Schema: test; Owner: -
--

SELECT pg_catalog.setval('items2_id_seq', 15, true);

DELETE FROM json_table;

INSERT INTO json_table VALUES ('{"foo":{"bar":"baz"},"id":1}');

INSERT INTO json_table VALUES ('{"id":3}');

INSERT INTO json_table VALUES ('{"id":0}');

DELETE FROM menagerie;

DELETE FROM no_pk;

INSERT INTO no_pk VALUES (NULL, NULL);

INSERT INTO no_pk VALUES ('1', '0');

INSERT INTO no_pk VALUES ('2', '0');

DELETE FROM nullable_integer;

INSERT INTO nullable_integer VALUES (NULL);

DELETE FROM users_projects;

INSERT INTO users_projects VALUES (1, 1);

INSERT INTO users_projects VALUES (1, 2);

INSERT INTO users_projects VALUES (2, 3);

INSERT INTO users_projects VALUES (2, 4);

INSERT INTO users_projects VALUES (3, 1);

INSERT INTO users_projects VALUES (3, 3);

DELETE FROM "Escap3e;";

INSERT INTO "Escap3e;" VALUES (1), (2), (3), (4), (5);

DELETE FROM "ghostBusters";

INSERT INTO "ghostBusters" VALUES (1), (3), (5);

DELETE FROM "withUnique";

INSERT INTO "withUnique" VALUES ('nodup', 'blah');

DELETE FROM addresses;

INSERT INTO addresses VALUES (1, 'address 1');

INSERT INTO addresses VALUES (2, 'address 2');

INSERT INTO addresses VALUES (3, 'address 3');

INSERT INTO addresses VALUES (4, 'address 4');

DELETE FROM orders;

INSERT INTO orders VALUES (1, 'order 1', 1, 2);

INSERT INTO orders VALUES (2, 'order 2', 3, 4);

DELETE FROM images;

INSERT INTO images(name, img) VALUES ('A.png', decode('iVBORw0KGgoAAAANSUhEUgAAAB4AAAAeAQMAAAAB/jzhAAAABlBMVEUAAAD/AAAb/40iAAAAP0lEQVQI12NgwAbYG2AE/wEYwQMiZB4ACQkQYZEAIgqAhAGIKLCAEQ8kgMT/P1CCEUwc4IMSzA3sUIIdCHECAGSQEkeOTUyCAAAAAElFTkSuQmCC', 'base64'));

INSERT INTO images(name, img) VALUES ('B.png', decode('iVBORw0KGgoAAAANSUhEUgAAAB4AAAAeAQMAAAAB/jzhAAAABlBMVEX///8AAP94wDzzAAAAL0lEQVQIW2NgwAb+HwARH0DEDyDxwAZEyGAhLODqHmBRzAcn5GAS///A1IF14AAA5/Adbiiz/0gAAAAASUVORK5CYII=', 'base64'));

DELETE FROM w_or_wo_comma_names;

INSERT INTO w_or_wo_comma_names VALUES ('Hebdon, John');

INSERT INTO w_or_wo_comma_names VALUES ('Williams, Mary');

INSERT INTO w_or_wo_comma_names VALUES ('Smith, Joseph');

INSERT INTO w_or_wo_comma_names VALUES ('David White');

INSERT INTO w_or_wo_comma_names VALUES ('Larry Thompson');

INSERT INTO w_or_wo_comma_names VALUES ('Double O Seven(007)');

INSERT INTO w_or_wo_comma_names VALUES ('"');

INSERT INTO w_or_wo_comma_names VALUES ('Double"Quote"McGraw"');

INSERT INTO w_or_wo_comma_names VALUES ('\');

INSERT INTO w_or_wo_comma_names VALUES ('/\Slash/\Beast/\');

DELETE FROM items_with_different_col_types;

INSERT INTO items_with_different_col_types VALUES (1, null, null, null, null, null, null, null);

DELETE FROM entities;

INSERT INTO entities ("id", "name") VALUES (1, 'entity 1');

INSERT INTO entities ("id", "name") VALUES (2, 'entity 2');

INSERT INTO entities ("id", "name") VALUES (3, 'entity 3');

INSERT INTO entities ("id", "name") VALUES (4, null);

DELETE FROM child_entities;

INSERT INTO child_entities VALUES (1, 'child entity 1', 1);

INSERT INTO child_entities VALUES (2, 'child entity 2', 1);

INSERT INTO child_entities VALUES (3, 'child entity 3', 2);

INSERT INTO child_entities VALUES (4, 'child entity 4', 1);

INSERT INTO child_entities VALUES (5, 'child entity 5', 1);

INSERT INTO child_entities VALUES (6, 'child entity 6', 2);

DELETE FROM grandchild_entities;

INSERT INTO grandchild_entities VALUES (1, 'grandchild entity 1', 1, null, null, null);

INSERT INTO grandchild_entities VALUES (2, 'grandchild entity 2', 1, null, null, null);

INSERT INTO grandchild_entities VALUES (3, 'grandchild entity 3', 2, null, null, null);

INSERT INTO grandchild_entities VALUES (4, '(grandchild,entity,4)', 2, null, null, '{"a": {"b":"foo"}}');

INSERT INTO grandchild_entities VALUES (5, '(grandchild,entity,5)', 2, null, null, '{"b":"bar"}');

DELETE FROM ranges;

INSERT INTO ranges ("id") VALUES (1);

INSERT INTO ranges ("id") VALUES (2);

INSERT INTO ranges ("id") VALUES (3);

INSERT INTO ranges ("id") VALUES (4);

INSERT INTO ranges ("id") VALUES (5);

DELETE FROM being;

INSERT INTO being VALUES (1), (2), (3), (4);

DELETE FROM descendant;

INSERT INTO descendant VALUES (1,1), (2,1), (3,1), (4,2);

DELETE FROM part;

INSERT INTO part VALUES (1), (2), (3), (4);

DELETE FROM being_part;

INSERT INTO being_part VALUES (1,1), (2,1), (3,2), (4,3);

DELETE FROM employees;

INSERT INTO employees ("first_name", "last_name", "company", "occupation") VALUES ('Frances M.', 'Roe', 'One-Up Realty', 'Author'),
  ('Daniel B.', 'Lyon', 'Dubrow''s Cafeteria', 'Packer'),
  ('Edwin S.', 'Smith', 'Pro Garden Management', 'Marine biologist');

DELETE FROM tiobe_pls;

INSERT INTO tiobe_pls VALUES ('Java', 1), ('C', 2), ('Python', 4);

DELETE FROM single_unique;

INSERT INTO single_unique (unique_key, value) VALUES (1, 'A');

DELETE FROM compound_unique;

INSERT INTO compound_unique (key1, key2, value) VALUES (1, 1, 'A');

DELETE FROM only_pk;

INSERT INTO only_pk VALUES (1), (2);

DELETE FROM family_tree;

INSERT INTO family_tree VALUES ('1', 'Parental Unit', NULL);

INSERT INTO family_tree VALUES ('2', 'Kid One', '1');

INSERT INTO family_tree VALUES ('3', 'Kid Two', '1');

INSERT INTO family_tree VALUES ('4', 'Grandkid One', '2');

INSERT INTO family_tree VALUES ('5', 'Grandkid Two', '3');

DELETE FROM managers;

INSERT INTO managers VALUES (1, 'Referee Manager');

INSERT INTO managers VALUES (2, 'Auditor Manager');

INSERT INTO managers VALUES (3, 'Acme Manager');

INSERT INTO managers VALUES (4, 'Umbrella Manager');

INSERT INTO managers VALUES (5, 'Cyberdyne Manager');

INSERT INTO managers VALUES (6, 'Oscorp Manager');

DELETE FROM organizations;

INSERT INTO organizations VALUES (1, 'Referee Org', null, null, 1);

INSERT INTO organizations VALUES (2, 'Auditor Org', null, null, 2);

INSERT INTO organizations VALUES (3, 'Acme', 1, 2, 3);

INSERT INTO organizations VALUES (4, 'Umbrella', 1, 2, 4);

INSERT INTO organizations VALUES (5, 'Cyberdyne', 3, 4, 5);

INSERT INTO organizations VALUES (6, 'Oscorp', 3, 4, 6);

SET search_path = private, pg_catalog;

DELETE FROM authors;

INSERT INTO authors VALUES (1, 'George Orwell');

INSERT INTO authors VALUES (2, 'Anne Frank');

INSERT INTO authors VALUES (3, 'Antoine de Saint-Exupéry');

INSERT INTO authors VALUES (4, 'J.D. Salinger');

INSERT INTO authors VALUES (5, 'Ray Bradbury');

INSERT INTO authors VALUES (6, 'William Golding');

INSERT INTO authors VALUES (7, 'Harper Lee');

INSERT INTO authors VALUES (8, 'Kurt Vonnegut');

INSERT INTO authors VALUES (9, 'Ken Kesey');

INSERT INTO authors VALUES (10, 'Fyodor Dostoevsky');

DELETE FROM publishers;

INSERT INTO publishers VALUES (1, 'Secker & Warburg');

INSERT INTO publishers VALUES (2, 'Contact Publishing');

INSERT INTO publishers VALUES (3, 'Reynal & Hitchcock');

INSERT INTO publishers VALUES (4, 'Little, Brown and Company');

INSERT INTO publishers VALUES (5, 'Ballantine Books');

INSERT INTO publishers VALUES (6, 'Faber and Faber');

INSERT INTO publishers VALUES (7, 'J. B. Lippincott & Co.');

INSERT INTO publishers VALUES (8, 'Delacorte');

INSERT INTO publishers VALUES (9, 'Viking Press & Signet Books');

DELETE FROM books;

INSERT INTO books VALUES (1, '1984', 1949, 1, 1);

INSERT INTO books VALUES (2, 'The Diary of a Young Girl', 1947, 2, 2);

INSERT INTO books VALUES (3, 'The Little Prince', 1947, 3, 3);

INSERT INTO books VALUES (4, 'The Catcher in the Rye', 1951, 4, 4);

INSERT INTO books VALUES (5, 'Farenheit 451', 1953, 5, 5);

INSERT INTO books VALUES (6, 'Lord of the Flies', 1954, 6, 6);

INSERT INTO books VALUES (7, 'To Kill a Mockingbird', 1960, 7, 7);

INSERT INTO books VALUES (8, 'Slaughterhouse-Five', 1969, 8, 8);

INSERT INTO books VALUES (9, 'One Flew Over the Cuckoo''s Nest', 1962, 9, 9);

INSERT INTO books VALUES (10, 'Crime and Punishment', 1866, 10, null);

SET search_path = "public", pg_catalog;

DELETE FROM person;

INSERT INTO person VALUES (1, 'John');

INSERT INTO person VALUES (2, 'Jane');

INSERT INTO person VALUES (3, 'Jake');

INSERT INTO person VALUES (4, 'Julie');

DELETE FROM message;

INSERT INTO message VALUES (1, 'Hello Jane', 1, 2);

INSERT INTO message VALUES (2, 'Hi John', 2, 1);

INSERT INTO message VALUES (3, 'How are you doing?', 1, 2);

INSERT INTO message VALUES (4, 'Hey Julie', 3, 4);

INSERT INTO message VALUES (5, 'What''s up Jake', 4, 3);

DELETE FROM space;

INSERT INTO space VALUES (1, 'space 1');

DELETE FROM zone;

INSERT INTO zone VALUES (1, 'zone 1', 2, 1);

INSERT INTO zone VALUES (2, 'zone 2', 2, 1);

INSERT INTO zone VALUES (3, 'store 3', 3, 1);

INSERT INTO zone VALUES (4, 'store 4', 3, 1);

DELETE FROM "UnitTest";

INSERT INTO "UnitTest" VALUES (1, 'unit test 1');

DELETE FROM json_arr;

INSERT INTO json_arr VALUES (1, '[1, 2, 3]');

INSERT INTO json_arr VALUES (2, '[4, 5, 6]');

INSERT INTO json_arr VALUES (3, '[[9, 8, 7], [11, 12, 13]]');

INSERT INTO json_arr VALUES (4, '[[[5, 6], 7, 8]]');

INSERT INTO json_arr VALUES (5, '[{"a": "A"}, {"b": "B"}]');

INSERT INTO json_arr VALUES (6, '[{"a": [1,2,3]}, {"b": [4,5]}]');

INSERT INTO json_arr VALUES (7, '{"c": [1,2,3], "d": [4,5]}');

INSERT INTO json_arr VALUES (8, '{"c": [{"d": [4,5,6,7,8]}]}');

INSERT INTO json_arr VALUES (9, '[{"0xy1": [1,{"23-xy-45": [2, {"xy-6": [3]}]}]}]');

INSERT INTO json_arr VALUES (10, '{"!@#$%^&*_a": [{"!@#$%^&*_b": 1}, {"!@#$%^&*_c": [2]}], "!@#$%^&*_d": {"!@#$%^&*_e": 3}}');

DELETE FROM jsonb_test;

INSERT INTO jsonb_test VALUES (1, '{ "a": {"b": 2} }');

INSERT INTO jsonb_test VALUES (2, '{ "c": [1,2,3] }');

INSERT INTO jsonb_test VALUES (3, '[{ "d": "test" }]');

INSERT INTO jsonb_test VALUES (4, '{ "e": 1 }');

DELETE FROM private.player;

INSERT into private.player
SELECT
  generate_series,
  'first_name_' || generate_series,
  'last_name_' || generate_series,
  '2018-10-11'
FROM generate_series(1, 12);

DELETE FROM contract;

INSERT INTO contract ("tournament", "purchase_price", "id", "first_name", "last_name", "birth_date") SELECT 'tournament_' || generate_series, 10*generate_series, generate_series, 'first_name_' || generate_series, 'last_name_' || generate_series, '2018-10-11' from generate_series(1, 6);

DELETE FROM isn_sample;

INSERT INTO isn_sample ("name") VALUES ('Mathematics: From the Birth of Numbers');

DELETE FROM "Server Today";

INSERT INTO "Server Today" ("cHostname", "Just A Server Model") VALUES
  ('argnim1    ', ' IBM,9113-550 (P5-550)'),
  ('argnim2    ', ' IBM,9113-550 (P5-550)'),
  ('daaa2nim71 ', ' IBM,9131-52A (P5-52A)'),
  ('daah3nim71 ', ' IBM,8406-71Y (P7-PS701)'),
  ('hbnim1     ', ' IBM,9133-55A (P5-55A)');

DELETE FROM pgrst_reserved_chars;

INSERT INTO pgrst_reserved_chars ("*id*", ":arr->ow::cast", "(inside,parens)", "a.dotted.column", "  col  w  space  ") VALUES
  ('1 ', ' arrow-1 ', ' parens-1 ', ' dotted-1 ', ' space-1'),
  ('2 ', ' arrow-2 ', ' parens-2 ', ' dotted-2 ', ' space-2'),
  ('3 ', ' arrow-3 ', ' parens-3 ', ' dotted-3 ', ' space-3');

DELETE FROM web_content;

INSERT INTO web_content VALUES (5, 'wat', null);

INSERT INTO web_content VALUES (0, 'tardis', 5);

INSERT INTO web_content VALUES (1, 'fezz', 0);

INSERT INTO web_content VALUES (2, 'foo', 0);

INSERT INTO web_content VALUES (3, 'bar', 0);

INSERT INTO web_content VALUES (4, 'wut', 1);

DELETE FROM app_users;

INSERT INTO app_users (id, email, "password") VALUES (1, 'test@123.com','pass');

INSERT INTO app_users (id, email, "password") VALUES (2, 'abc@123.com','pass');

INSERT INTO app_users (id, email, "password") VALUES (3, 'def@123.com','pass');

DELETE FROM private.pages;

INSERT INTO private.pages VALUES (1, 'http://postgrest.org/en/v6.0/api.html');

INSERT INTO private.pages VALUES (2, 'http://postgrest.org/en/v6.0/admin.html');

DELETE FROM private.referrals;

INSERT INTO private.referrals VALUES ('github.com', 1);

INSERT INTO private.referrals VALUES ('hub.docker.com', 2);

DELETE FROM big_projects;

INSERT INTO big_projects (big_project_id, name)
VALUES (1, 'big project 1'),
       (2, 'big project 2');

DELETE FROM sites;

INSERT INTO sites (site_id, name, main_project_id)
VALUES (1, 'site 1', 1),
       (2, 'site 2', null),
       (3, 'site 3', 2),
       (4, 'site 4', null);

DELETE FROM jobs;

INSERT INTO jobs (job_id, name, site_id, big_project_id)
VALUES ('bc5d5362-b881-438f-b9f5-7417e08704ed', 'job 1-1', 1, 1),
       ('3bd52697-033b-4edd-8a28-46a9c04b7c1e', 'job 2-1', 2, 1),
       ('e6e67e4e-19b1-11e9-ab14-d663bd873d93', 'job 2-2', 2, 2);

DELETE FROM departments;

DELETE FROM agents;

INSERT INTO agents (id, name)
VALUES (1, 'agent 1'),
       (2, 'agent 2'),
       (3, 'agent 3'),
       (4, 'agent 4');

INSERT INTO departments (id, name, head_id)
VALUES (1, 'dep 1', 1),
       (2, 'dep 3', 3);

UPDATE agents SET department_id = 1 WHERE id in (1, 2);

UPDATE agents SET department_id = 2 WHERE id in (3, 4);

DELETE FROM schedules;

INSERT INTO schedules VALUES(1, 'morning', '06:00:00', '11:59:00');

INSERT INTO schedules VALUES(2, 'afternoon', '12:00:00', '17:59:00');

INSERT INTO schedules VALUES(3, 'night', '18:00:00', '23:59:00');

INSERT INTO schedules VALUES(4, 'early morning', '00:00:00', '05:59:00');

DELETE FROM activities;

INSERT INTO activities(id, schedule_id, car_id)    VALUES(1, 1, 'CAR-349');

INSERT INTO activities(id, schedule_id, camera_id) VALUES(2, 3, 'CAM-123');

DELETE FROM unit_workdays;

INSERT INTO unit_workdays VALUES(1, '2019-12-02', 1, 1, 2, 3);

DELETE FROM v1.parents;

INSERT INTO v1.parents VALUES(1, 'parent v1-1'), (2, 'parent v1-2');

DELETE FROM v1.children;

INSERT INTO v1.children VALUES(1, 'child v1-1', 1), (2, 'child v1-2', 2);

DELETE FROM v2.parents;

INSERT INTO v2.parents VALUES(3, 'parent v2-3'), (4, 'parent v2-4');

DELETE FROM v2.children;

INSERT INTO v2.children VALUES(1, 'child v2-3', 3);

DELETE FROM v2.another_table;

INSERT INTO v2.another_table VALUES(5, 'value 5'), (6, 'value 6');

DELETE FROM private.stuff;

INSERT INTO private.stuff (id, name) VALUES (1, 'stuff 1');

DELETE FROM private.screens;

INSERT INTO private.screens(name) VALUES ('banana'), ('helicopter'), ('formula 1 banana');

DELETE FROM private.labels;
INSERT INTO private.labels(name) VALUES ('vehicles'), ('fruit');

DELETE FROM private.label_screen;
INSERT INTO private.label_screen(label_id, screen_id) VALUES
    ((SELECT id FROM labels WHERE name='vehicles'), (SELECT id FROM screens WHERE name='helicopter')),
    ((SELECT id FROM labels WHERE name='vehicles'), (SELECT id FROM screens WHERE name='formula 1 banana')),
    ((SELECT id FROM labels WHERE name='fruit'), (SELECT id FROM screens WHERE name='banana')),
    ((SELECT id FROM labels WHERE name='fruit'), (SELECT id FROM screens WHERE name='formula 1 banana'));

DELETE FROM private.actors;

INSERT INTO private.actors (id, name) VALUES (1,'john'), (2,'mary');

DELETE FROM private.films;

INSERT INTO private.films (id, title) VALUES (12,'douze commandements'), (2001,'odyssée de l''espace');

DELETE FROM private.personnages;

INSERT INTO private.personnages (film_id, role_id, character) VALUES (12,1,'méchant'), (2001,2,'astronaute');

DELETE FROM "public".car_brands;
INSERT INTO "public".car_brands(name) VALUES ('DMC');

INSERT INTO "public".car_brands(name) VALUES ('Ferrari');

INSERT INTO "public".car_brands(name) VALUES ('Lamborghini');

DELETE FROM "public".products;

INSERT INTO "public".products (id, name) VALUES (1,'product-1'), (2,'product-2'), (3,'product-3');

DELETE FROM "public".suppliers;

INSERT INTO "public".suppliers (id, name) VALUES (1,'supplier-1'), (2,'supplier-2'), (3, 'supplier-3');

DELETE FROM "public".products_suppliers;

INSERT INTO "public".products_suppliers (product_id, supplier_id) VALUES (1,1), (1,2), (2,1), (2,3);

DELETE FROM "public".trade_unions;

INSERT INTO "public".trade_unions (id, name) VALUES (1,'union-1'), (2,'union-2'), (3, 'union-3'), (4, 'union-4');

DELETE FROM "public".suppliers_trade_unions;

INSERT INTO "public".suppliers_trade_unions (supplier_id, trade_union_id) VALUES (1,1), (1,2), (2,3), (2,4);

DELETE FROM "public".client;

INSERT INTO "public".client (id,name) values (1,'Walmart'),(2,'Target'),(3,'Big Lots');

DELETE FROM "public".contact;

INSERT INTO "public".contact (id,name, clientid) values (1,'Wally Walton',1),(2,'Wilma Wellers',1),(3,'Tabby Targo',2),(4,'Bobby Bots',3),(5,'Bonnie Bits',3),(6,'Billy Boats',3) returning *;

DELETE FROM "public".clientinfo;

INSERT INTO "public".clientinfo (id,clientid, other) values (1,1,'123 Main St'),(2,2,'456 South 3rd St'),(3,3,'789 Palm Tree Ln');

DELETE FROM "public".chores;

INSERT INTO "public".chores (id, name, done) values (1, 'take out the garbage', true), (2, 'do the laundry', false), (3, 'wash the dishes', null);

DELETE FROM "public".fav_numbers;

INSERT INTO "public".fav_numbers ("person") VALUES ('A'),
  ('B');

DELETE FROM "public".arrays;

INSERT INTO "public".arrays ("id") VALUES (0),
  (1);

DELETE FROM "public".oid_test;

INSERT INTO oid_test(id, oid_col) VALUES (1, '12345');

DELETE FROM private.internal_job;

INSERT INTO private.internal_job (id, parent_id) VALUES (1, null);

INSERT INTO private.internal_job (id, parent_id) VALUES (2, 1);

DELETE FROM "public".test;

INSERT INTO "public".test (id, parent_id) VALUES (1, null), (2, 1);

DELETE FROM shops;

INSERT INTO shops(id, address) VALUES (1, '1369 Cambridge St');

INSERT INTO shops(id, address) VALUES (2, '757 Massachusetts Ave');

INSERT INTO shops(id, address) VALUES (3, '605 W Kendall St');

DELETE FROM shop_bles;

INSERT INTO shop_bles(id, name, shop_id) VALUES (1, 'Beacon-1', 1);

INSERT INTO shop_bles(id, name, shop_id) VALUES (2, 'Beacon-2', 1);

DELETE FROM "SPECIAL ""@/\#~_-".languages;

INSERT INTO "SPECIAL ""@/\#~_-".languages (id, name) VALUES (1, 'English'), (2, 'Spanish');

DELETE FROM "SPECIAL ""@/\#~_-".names;

INSERT INTO "SPECIAL ""@/\#~_-".names (id, name, language_id) VALUES (1, 'John', 1), (2, 'Mary', 1), (3, 'José', 2);

DELETE FROM do$llar$s;

INSERT INTO do$llar$s (a$num$) VALUES (100), (200), (300);

DELETE FROM safe_update_items;

INSERT INTO safe_update_items(id, name, observation) VALUES (1, 'item-1', NULL), (2, 'item-2', NULL), (3, 'item-3', NULL);

DELETE FROM safe_delete_items;

INSERT INTO safe_delete_items(id, name, observation) VALUES (1, 'item-1', NULL), (2, 'item-2', NULL), (3, 'item-3', NULL);

DELETE FROM unsafe_update_items;

INSERT INTO unsafe_update_items(id, name, observation) VALUES (1, 'item-1', NULL), (2, 'item-2', NULL), (3, 'item-3', NULL);

DELETE FROM unsafe_delete_items;

INSERT INTO unsafe_delete_items(id, name, observation) VALUES (1, 'item-1', NULL), (2, 'item-2', NULL), (3, 'item-3', NULL);

DELETE FROM designers;

INSERT INTO designers(id, name) VALUES (1, 'Sid Meier'), (2, 'Hironobu Sakaguchi');

DELETE FROM videogames;

INSERT INTO videogames(id, name, designer_id) VALUES (1, 'Civilization I', 1), (2, 'Civilization II', 1), (3, 'Final Fantasy I', 2), (4, 'Final Fantasy II', 2);

DELETE FROM students;

INSERT INTO students(id, code, name) VALUES (1, '0001', 'John Doe'), (2, '0002', 'Jane Doe');

DELETE FROM students_info;

INSERT INTO students_info(id, code, address) VALUES (1, '0001', 'Street 1'), (2, '0002', 'Street 2');

DELETE FROM country;

INSERT INTO country(id, name) VALUES (1, 'Afghanistan'), (2, 'Algeria');

DELETE FROM capital;

INSERT INTO capital(id, name, country_id) VALUES (1, 'Kabul', 1), (2, 'Algiers', 2);

DELETE FROM trash;

INSERT INTO trash(id) VALUES (1), (2), (3);

DELETE FROM trash_details;

INSERT INTO trash_details(id,jsonb_col) VALUES (1,'{"key": 10}'), (2,'{"key": 6}'), (3,'{"key": 8}');

DELETE FROM posters;

INSERT INTO posters(id,name) VALUES (1,'Mark'), (2,'Elon'), (3,'Bill'), (4,'Jeff');

DELETE FROM subscriptions;

INSERT INTO subscriptions(subscriber,subscribed) VALUES (3,1), (4,1), (1,2);

DELETE FROM datarep_todos;

INSERT INTO datarep_todos VALUES (1, 'Report', 0, '2018-01-02', '\x89504e470d0a1a0a0000000d4948445200000001000000010100000000376ef924000000001049444154789c62600100000000ffff03000000060005057bfabd400000000049454e44ae426082', '2017-12-14 01:02:30', 12.50);

INSERT INTO datarep_todos VALUES (2, 'Essay', 256, '2018-01-03', NULL, '2017-12-14 01:02:30', 100000000000000.13);

INSERT INTO datarep_todos VALUES (3, 'Algebra', 123456, '2018-01-01 14:12:34.123456');

INSERT INTO datarep_todos VALUES (4, 'Opus Magnum', NULL, NULL);

DELETE FROM datarep_next_two_todos;

INSERT INTO datarep_next_two_todos VALUES (1, 2, 3, 'school related');

INSERT INTO datarep_next_two_todos VALUES (2, 1, 3, 'do these first');

DELETE FROM bitchar_with_length;

INSERT INTO bitchar_with_length(char) VALUES ('aaaaa');

INSERT INTO bitchar_with_length(char) VALUES ('bbbbb');

DELETE FROM table_a;

INSERT INTO table_a(id, name) VALUES (1, 'Not null 1'), (2, null), (3, 'Not null 2');

DELETE FROM table_b;

INSERT INTO table_b(table_a_id, name) VALUES (1, 'Test 1'), (2, 'Test 2'), (null, 'Test 3');

DELETE FROM lines;

INSERT INTO lines ("id", "name") VALUES (1, 'line-1'),
  (2, 'line-2');

DELETE FROM timestamps;

INSERT INTO timestamps VALUES ('2023-10-18 12:37:59.611000+0000');

INSERT INTO timestamps VALUES ('2023-10-18 14:37:59.611000+0000');

INSERT INTO timestamps VALUES ('2023-10-18 16:37:59.611000+0000');

DELETE FROM project_invoices;

INSERT INTO project_invoices VALUES (1, 100, 1);

INSERT INTO project_invoices VALUES (2, 200, 1);

INSERT INTO project_invoices VALUES (3, 500, 2);

INSERT INTO project_invoices VALUES (4, 700, 2);

INSERT INTO project_invoices VALUES (5, 1200, 3);

INSERT INTO project_invoices VALUES (6, 2000, 3);

INSERT INTO project_invoices VALUES (7, 100, 4);

INSERT INTO project_invoices VALUES (8, 4000, 4);

DELETE FROM budget_categories;

INSERT INTO budget_categories VALUES (1, 'Beanie Babies', 'Brian Smith', 1000.31);

INSERT INTO budget_categories VALUES (2, 'DVDs', 'Jane Clarkson', 2000.12);

INSERT INTO budget_categories VALUES (3, 'Pizza', 'Brian Smith', 1000.11);

INSERT INTO budget_categories VALUES (4, 'Opera Tickets', 'Jane Clarkson', 7000.41);

INSERT INTO budget_categories VALUES (5, 'Nuclear Fusion Research', 'Sally Hughes', 500.23);

INSERT INTO budget_categories VALUES (6, 'T-5hirts', 'Dana de Groot', 500.33);

DELETE FROM budget_expenses;

INSERT INTO budget_expenses VALUES (1, 200.26, 1);

INSERT INTO budget_expenses VALUES (2, 400.26, 3);

INSERT INTO budget_expenses VALUES (3, 100.22, 4);

INSERT INTO budget_expenses VALUES (5, 900.27, 5);

DELETE FROM factories;

INSERT INTO factories VALUES (1, 'Factory A');

INSERT INTO factories VALUES (2, 'Factory B');

INSERT INTO factories VALUES (3, 'Factory C');

INSERT INTO factories VALUES (4, 'Factory D');

DELETE FROM process_categories;

INSERT INTO process_categories VALUES (1, 'Batch');

INSERT INTO process_categories VALUES (2, 'Mass');

DELETE FROM processes;

INSERT INTO processes VALUES (1, 'Process A1', 1, 1);

INSERT INTO processes VALUES (2, 'Process A2', 1, 2);

INSERT INTO processes VALUES (3, 'Process B1', 2, 1);

INSERT INTO processes VALUES (4, 'Process B2', 2, 1);

INSERT INTO processes VALUES (5, 'Process C1', 3, 2);

INSERT INTO processes VALUES (6, 'Process C2', 3, 2);

INSERT INTO processes VALUES (7, 'Process XX', 3, 2);

INSERT INTO processes VALUES (8, 'Process YY', 3, 2);

DELETE FROM process_costs;

INSERT INTO process_costs VALUES (1, 150.00);

INSERT INTO process_costs VALUES (2, 200.00);

INSERT INTO process_costs VALUES (3, 180.00);

INSERT INTO process_costs VALUES (4, 70.00);

INSERT INTO process_costs VALUES (5, 40.00);

INSERT INTO process_costs VALUES (6, 70.00);

INSERT INTO process_costs VALUES (8, 40.00);

DELETE FROM supervisors;

INSERT INTO supervisors VALUES (1, 'Mary');

INSERT INTO supervisors VALUES (2, 'John');

INSERT INTO supervisors VALUES (3, 'Peter');

INSERT INTO supervisors VALUES (4, 'Sarah');

INSERT INTO supervisors VALUES (5, 'Jane');

DELETE FROM process_supervisor;

INSERT INTO process_supervisor VALUES (1, 1);

INSERT INTO process_supervisor VALUES (2, 2);

INSERT INTO process_supervisor VALUES (3, 3);

INSERT INTO process_supervisor VALUES (3, 4);

INSERT INTO process_supervisor VALUES (4, 1);

INSERT INTO process_supervisor VALUES (4, 2);

INSERT INTO process_supervisor VALUES (5, 3);

INSERT INTO process_supervisor VALUES (6, 3);

DELETE FROM operators;

INSERT INTO operators VALUES (1, 'Anne', '{"id": "543210", "afk": true}');

INSERT INTO operators VALUES (2, 'Louis', '{"id": "012345"}');

INSERT INTO operators VALUES (3, 'Jeff', '{"id": "666666", "afk": true}');

INSERT INTO operators VALUES (4, 'Liz', '{"id": "999999"}');

INSERT INTO operators VALUES (5, 'Alfred', '{"id": "000000"}');

DELETE FROM process_operator;

INSERT INTO process_operator VALUES (1,1);

INSERT INTO process_operator VALUES (1,2);

INSERT INTO process_operator VALUES (2,1);

INSERT INTO process_operator VALUES (2,2);

INSERT INTO process_operator VALUES (2,3);

INSERT INTO process_operator VALUES (3,3);

INSERT INTO process_operator VALUES (4,1);

INSERT INTO process_operator VALUES (4,3);

INSERT INTO process_operator VALUES (6,3);

INSERT INTO process_operator VALUES (6,5);

INSERT INTO process_operator VALUES (7,5);

DELETE FROM factory_buildings;

INSERT INTO factory_buildings VALUES (1, 'A001', 150, 'A', 1, '{"ins": "2024C", "pending": true}');

INSERT INTO factory_buildings VALUES (2, 'A002', 200, 'A', 1, '{"ins": "2025A", "pending": true}');

INSERT INTO factory_buildings VALUES (3, 'B001', 50, 'B', 2, '{"ins": "2025A", "pending": true}');

INSERT INTO factory_buildings VALUES (4, 'B002', 120, 'C', 2, '{"ins": "2023A"}');

INSERT INTO factory_buildings VALUES (5, 'C001', 240, 'B', 3, '{"ins": "2022B"}' );

INSERT INTO factory_buildings VALUES (6, 'D001', 310, 'A', 4, '{"ins": "2024C", "pending": true}');

DELETE FROM surr_serial_upsert;

INSERT INTO surr_serial_upsert(name, extra) VALUES ('value', 'existing value');

DELETE FROM surr_gen_default_upsert;

INSERT INTO surr_gen_default_upsert(name, extra) VALUES ('value', 'existing value');

DELETE FROM "Surr_Gen_Default_Upsert";

INSERT INTO "Surr_Gen_Default_Upsert"(name, extra) VALUES ('value cs', 'existing value cs');

DELETE FROM tsearch_to_tsvector;

INSERT INTO tsearch_to_tsvector(text_search) VALUES ('It''s kind of fun to do the impossible');

INSERT INTO tsearch_to_tsvector(text_search) VALUES ('But also fun to do what is possible');

INSERT INTO tsearch_to_tsvector(text_search) VALUES ('Fat cats ate rats');

INSERT INTO tsearch_to_tsvector(text_search) VALUES ('C''est un peu amusant de faire l''impossible');

INSERT INTO tsearch_to_tsvector(text_search) VALUES ('Es ist eine Art Spaß, das Unmögliche zu machen');

UPDATE tsearch_to_tsvector SET jsonb_search = jsonb_build_object('text_search', text_search);

DELETE FROM artists;

INSERT INTO artists
VALUES (1, 'duster'), (2, 'black country, new road'), (3, 'bjork');

DELETE FROM albums;

INSERT INTO albums
VALUES (1, 'stratosphere', 1),
       (2, 'ants from up above',2),
       (3, 'vespertine',3),
       (4, 'contemporary movement', 1);

DELETE FROM places;

INSERT INTO places (name)
VALUES ('Lake'), ('Mountain'), ('Beach');

DELETE FROM visits;

INSERT INTO visits (place_id, start_time, end_time) VALUES (1, '2025-01-01 10:00', '2025-01-01 11:00'),
  (1, '2025-01-01 15:00', '2025-01-01 16:00'),
  (1, '2025-01-01 20:00', '2025-01-01 21:00'),
  (2, '2024-11-01 09:00', '2024-11-01 10:00'),
  (3, '2024-12-02 13:00', '2024-12-02 14:00'),
  (1, '2023-01-02 20:00', '2023-01-01 21:00');

DELETE FROM bets;
INSERT INTO bets (id) SELECT generate_series(1,1000);

