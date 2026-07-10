DROP DATABASE IF EXISTS pizza_express;
CREATE DATABASE pizza_express;
USE pizza_express;

CREATE TABLE zip (
 id INT UNSIGNED NOT NULL AUTO_INCREMENT, -- bigint UNSIGNED NOT NULL auto_increment
 zip SMALLINT(4) UNSIGNED NOT NULL,
 city VARCHAR(255) NOT NULL,

 PRIMARY KEY(id),
 UNIQUE(zip, city)
);

CREATE TABLE customer (
 id INT UNSIGNED NOT NULL AUTO_INCREMENT,
 fk_zip_id INT UNSIGNED NOT NULL,
 firstname VARCHAR(255) NOT NULL,
 lastname	VARCHAR(255) NOT NULL,
 address VARCHAR(255) NOT NULL,
 email VARCHAR(384) NOT NULL UNIQUE,
 password VARCHAR(255) NOT NULL,
 phone VARCHAR(255),

 PRIMARY KEY(id),
 FOREIGN KEY(fk_zip_id) REFERENCES zip(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE category (
 id INT UNSIGNED NOT NULL AUTO_INCREMENT,
 category VARCHAR(255) NOT NULL UNIQUE,
 PRIMARY KEY(id)
);

CREATE TABLE product (
 id INT UNSIGNED NOT NULL AUTO_INCREMENT,
 fk_category_id	INT UNSIGNED NOT NULL,
 name VARCHAR(255) NOT NULL,
 description	VARCHAR(255) NOT NULL,
 price DECIMAL(6,2) NOT NULL,

 PRIMARY KEY(id),
 FOREIGN KEY(fk_category_id) REFERENCES category(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE order_entry (
 id INT UNSIGNED NOT NULL AUTO_INCREMENT,
 fk_customer_id INT UNSIGNED NOT NULL,
 ordered_at DATETIME NOT NULL DEFAULT current_timestamp,
 delivered_at DATETIME NULL,

 PRIMARY KEY(id),
 FOREIGN KEY(fk_customer_id) REFERENCES customer(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE product_order_entry (
 id	INT UNSIGNED NOT NULL AUTO_INCREMENT,
 fk_product_id INT UNSIGNED NOT NULL,
 fk_order_entry_id INT UNSIGNED NOT NULL,
 amount INT UNSIGNED NOT NULL DEFAULT 1,
 price DECIMAL(6,2) NULL,

 PRIMARY KEY(id),
 FOREIGN KEY(fk_product_id) REFERENCES product(id) ON UPDATE CASCADE ON DELETE CASCADE,
 FOREIGN KEY(fk_order_entry_id) REFERENCES order_entry(id) ON UPDATE CASCADE ON DELETE CASCADE
);

-- Sie wollen in der Kundentabelle auch die mobile Telefonnummer speichern. Fügen Sie eine entsprechende Spalte hinzu
ALTER TABLE customer ADD mobile VARCHAR(255);

-- Ändern Sie den Namen der Spalte für die Produktbezeichung
ALTER TABLE product CHANGE name product_name VARCHAR(255) NOT NULL;
ALTER TABLE product CHANGE product_name name VARCHAR(255) NOT NULL;

-- Ändern Sie den Datentyp des Produktpreises auf DECIMAL(6,2) UNSIGNED
ALTER TABLE product MODIFY price DECIMAL(6,2) UNSIGNED;

-- Setzten Sie nachträglich NOT NULL für den Produktpreis
ALTER TABLE product MODIFY price DECIMAL(6,2) NOT NULL;

-- Fügen Sie ein neues Attribut (created_at, DATETIME) in die Produkttabelle ein und stellen Sie sicher, dass dieses Feld automatisch mit dem aktuellen Zeitpunkt bei einem INSERT befüllt wird.
ALTER TABLE product ADD created_at DATETIME NOT NULL DEFAULT NOW();

-- Entfernen Sie die Spalte für die mobile Telefonnummer wieder
ALTER TABLE customer DROP mobile;

-- Entfernen Sie den Foreign Key CONSTRAINT vom Postleitzahlen Fremdschlüssel aus der Kundentabelle
SHOW CREATE TABLE customer; -- Name des CONSTRAINTs herausfinden (z.B. customer_ibfk_1)
ALTER TABLE customer DROP CONSTRAINT customer_ibfk_1;

-- Fügen Sie den Foreign Key CONSTRAINT wieder hinzu
ALTER TABLE customer ADD foreign key(fk_zip_id) REFERENCES zip(id);

USE pizza_express;

-- Transaktion starten
BEGIN;

INSERT INTO zip (zip, city) VALUES
 (8001, 'Zürich'),
 (8002, 'Zürich'),
 (8048, 'Zürich'),
 (8008, 'Zürich'),
 (8049, 'Zürich'),
 (8051, 'Zürich'),
 (8902, 'Urdorf'),
 (8952, 'Schlieren'),
 (8600, 'Dübendorf'),
 (8402, 'Winterthur');

INSERT INTO customer (fk_zip_id, firstname, lastname, address, email, password, phone) VALUES
 (2, 'Hans', 'Muster', 'Nordstrasse 1', 'hans@muster.com', sha('insecure'), '044 123 45 67'),
 (5, 'Barbara', 'Meier', 'Baslerstrasse 20', 'b.meier@gmail.com', sha('1234'), '044 101 45 80'),
 (6, 'Fritz', 'Müller', 'Bernerstrasse 209', 'fritz@mueller.com', sha('spiderman'), NULL),
 (3, 'Freddy', 'Brunner', 'Blumenweg 10', 'fred@outlook.com', sha('porsche'), '044 330 23 09'),
 (4, 'Peter', 'Keller', 'Seestrasse 171', 'peter.keller@outlook.com', sha('letmein'), NULL),
 (7, 'Bruno', 'Kuster', 'Dorfstrasse 21', 'bk@hotmail.com', sha('kakadu'), '044 880 13 50'),
 (8, 'Brigitte', 'Maler', 'Alte Landstrasse 201', 'brigitte@gmail.com', sha('starwars'), '043 627 89 14'),
 (6, 'Andrea', 'Pfister', 'Stadthausstrasse 9a', 'apfister98@gmail.com', sha('4ocean'), NULL),
 (9, 'Heinz', 'Fuhrer', 'Überlandstrasse 21', 'hfuhrer@outlook.com', sha('foobar'), '044 443 50 84'),
 (10, 'Stephanie', 'Gerber', 'Schulhausstrasse 4', 'stephi@gmail.com', sha('password'), '078 210 40 53');

INSERT INTO category (category) VALUES
 ('Pizza'),
 ('Salate'),
 ('Getränke'),
 ('Pasta'),
 ('Dessert');

INSERT INTO product (fk_category_id, name, description, price) VALUES
 (1, 'Margherita', 'Tomaten, Mozzarella', 17.00),
 (1, 'Prosciutto', 'Tomaten, Schinken, Mozzarella', 18.00),
 (1, 'Siziliana', 'Tomaten, Salami, Mozzarella', 19.00),
 (1, 'Quattro Stagioni', 'Tomaten, Schinken, Peperoni, Artischocken, Mozzarella', 17.00),
 (1, 'Padrone', 'Tomaten, Kalbfleisch, Mozzarella', 17.00),
 (2, 'Kleiner grüner Salat', 'Grüner Blattsalat', 6.00),
 (2, 'Kleiner gemischter Salat', 'Gemischter Blattsalat', 7.00),
 (3, 'Coca-Cola', '5dl', 4.50),
 (3, 'Fanta', '5dl', 4.50),
 (3, 'Valser', '5dl', 4.50),
 (3, 'Red Bull', '33cl', 5.50),
 (1, 'Hawaii', 'Tomaten, Schinken, Ananas, Mozzarella', 18.00),
 (1, 'Tonno', 'Tomaten, Thunfisch, Mozzarella', 18.00),
 (1, 'Fiorentina', 'Tomaten, Zwiebeln, Spinat, Mascarpone, Mozzarella', 19.00),
 (1, 'Calzone', 'Tomaten, Schinken, Champignons, Ei, Mozzarella', 20.00),
 (1, 'Ai Funghi', 'Tomaten, Champignons, Mozzarella', 18.00),
 (3, 'Sprite', '5dl', 4.50),
 (3, 'Red Bull', '50cl', 4.50),
 (2, 'Insalata Caprese', 'Tomaten, Mozzarella, Balsamico', 11.00),
 (4, 'Spaghetti Carbonara', 'Rahmsauce, Zwiebel, Speck, Käse', 17.00),
 (4, 'Spaghetti Bolognese', 'Tomatensauce mit Rindfleisch', 18.00),
 (4, 'Spaghetti Aglio e olio', 'Tomatensauce mit Rindfleisch', 16.00),
 (4, 'Penne Arrabiata', 'Scharfe Tomatensauce', 16.00);


INSERT INTO order_entry (fk_customer_id, ordered_at, delivered_at) VALUES
 (2, CURRENT_TIMESTAMP - INTERVAL 5 DAY, CURRENT_TIMESTAMP - INTERVAL 3 DAY),
 (1, CURRENT_TIMESTAMP - INTERVAL 5 DAY, NULL),
 (4, CURRENT_TIMESTAMP - INTERVAL 5 DAY, CURRENT_TIMESTAMP - INTERVAL 1 DAY),
 (2, CURRENT_TIMESTAMP - INTERVAL 5 DAY, NULL),
 (2, CURRENT_TIMESTAMP - INTERVAL 4 DAY, NULL),
 (1, CURRENT_TIMESTAMP - INTERVAL 4 DAY, NULL),
 (3, CURRENT_TIMESTAMP - INTERVAL 4 DAY, NULL),
 (5, CURRENT_TIMESTAMP - INTERVAL 4 DAY, NULL),
 (6, CURRENT_TIMESTAMP - INTERVAL 4 DAY, CURRENT_TIMESTAMP - INTERVAL 1 DAY),
 (1, CURRENT_TIMESTAMP - INTERVAL 4 DAY, NULL),
 (3, CURRENT_TIMESTAMP - INTERVAL 4 DAY, NULL),
 (7, CURRENT_TIMESTAMP - INTERVAL 3 DAY, NULL),
 (4, CURRENT_TIMESTAMP - INTERVAL 3 DAY, NULL),
 (4, CURRENT_TIMESTAMP - INTERVAL 3 DAY, NULL),
 (8, CURRENT_TIMESTAMP - INTERVAL 2 DAY, NULL),
 (9, CURRENT_TIMESTAMP - INTERVAL 2 DAY, CURRENT_TIMESTAMP),
 (1, CURRENT_TIMESTAMP - INTERVAL 1 DAY, NULL),
 (5, CURRENT_TIMESTAMP - INTERVAL 1 DAY, NULL),
 (8, CURRENT_TIMESTAMP - INTERVAL 1 DAY, CURRENT_TIMESTAMP - INTERVAL 1 DAY),
 (7, CURRENT_TIMESTAMP - INTERVAL 1 DAY, NULL),
 (5, CURRENT_TIMESTAMP - INTERVAL 1 DAY, NULL),
 (9, CURRENT_TIMESTAMP, NULL),
 (2, CURRENT_TIMESTAMP, NULL),
 (5, CURRENT_TIMESTAMP, NULL),
 (3, CURRENT_TIMESTAMP, NULL),
 (6, CURRENT_TIMESTAMP, NULL);

INSERT INTO product_order_entry (fk_product_id, fk_order_entry_id, amount) VALUES
 (3, 1, 1),
 (4, 1, 2),
 (5, 1, 3),
 (1, 2, 1),
 (3, 2, 1),
 (2, 3, 1),
 (2, 4, 2),
 (7, 4, 2),
 (8, 5, 1),
 (6, 5, 1),
 (1, 5, 4),
 (3, 5, 1),
 (1, 6, 1),
 (6, 6, 3),
 (2, 6, 1),
 (3, 7, 1),
 (4, 7, 2),
 (3, 1, 1),
 (4, 1, 2),
 (5, 1, 3),
 (1, 2, 1),
 (3, 2, 1),
 (2, 3, 1),
 (2, 4, 2),
 (7, 4, 2),
 (8, 5, 1),
 (6, 5, 1),
 (1, 5, 4),
 (3, 5, 1),
 (1, 6, 1),
 (6, 6, 3),
 (2, 6, 1),
 (3, 7, 1),
 (4, 7, 2),
 (3, 1, 1),
 (4, 1, 2),
 (5, 1, 3),
 (1, 2, 1),
 (3, 2, 1),
 (2, 3, 1),
 (2, 4, 2),
 (7, 4, 2),
 (8, 5, 1),
 (6, 5, 1),
 (1, 5, 4),
 (3, 5, 1),
 (1, 6, 1),
 (6, 6, 3),
 (2, 6, 1),
 (3, 7, 1),
 (4, 7, 2),
 (3, 8, 1),
 (4, 8, 2),
 (5, 8, 3),
 (1, 8, 1),
 (3, 8, 1),
 (2, 9, 1),
 (2, 9, 2),
 (17, 10, 1),
 (5, 11, 1),
 (15, 11, 1),
 (10, 11, 1),
 (13, 12, 1),
 (1, 12, 2),
 (13, 13, 2),
 (12, 14, 1),
 (11, 14, 1),
 (18, 14, 2),
 (3, 14, 1),
 (14, 15, 2),
 (15, 15, 3),
 (11, 15, 1),
 (13, 15, 1),
 (5, 15, 4),
 (16, 15, 2),
 (7, 15, 2),
 (8, 16, 3),
 (14, 16, 1),
 (13, 16, 2),
 (17, 17, 1),
 (16, 18, 1),
 (6, 19, 1),
 (2, 19, 1),
 (6, 19, 1),
 (4, 20, 1),
 (8, 20, 1),
 (14, 21, 1),
 (19, 21, 1),
 (9, 21, 2),
 (2, 22, 1),
 (12, 23, 1),
 (8, 23, 3),
 (18, 23, 1),
 (12, 24, 5),
 (15, 24, 2),
 (3, 24, 2),
 (3, 25, 1),
 (6, 26, 1),
 (14, 26, 1),
 (9, 26, 1);

-- Aktuellen Preis setzen
UPDATE
 product p INNER JOIN product_order_entry pb ON p.id = pb.fk_product_id
 SET pb.price = p.price
;

-- Transaktion abschliessen
COMMIT;
