/* AUTO-EXTRACTED from sql-studio.html (script block 0) — DO NOT EDIT HERE.
   Edit the lite tool, then re-run: node scripts/extract-core.mjs
   Drift is caught by: npm run test:core */

/* Demo schema: a small lending library — enough tables for joins,
   foreign keys, groups and dates. Generic sample data, nothing external. */
const DEMO_SQL = `DROP DATABASE IF EXISTS library;
CREATE DATABASE library;
USE library;

CREATE TABLE author (
 id INT UNSIGNED NOT NULL AUTO_INCREMENT,
 name VARCHAR(255) NOT NULL,
 country VARCHAR(100),

 PRIMARY KEY(id)
);

CREATE TABLE genre (
 id INT UNSIGNED NOT NULL AUTO_INCREMENT,
 name VARCHAR(100) NOT NULL UNIQUE,

 PRIMARY KEY(id)
);

CREATE TABLE book (
 id INT UNSIGNED NOT NULL AUTO_INCREMENT,
 fk_author_id INT UNSIGNED NOT NULL,
 fk_genre_id INT UNSIGNED NOT NULL,
 title VARCHAR(255) NOT NULL,
 published_year SMALLINT,
 price DECIMAL(6,2) NOT NULL,

 PRIMARY KEY(id),
 FOREIGN KEY(fk_author_id) REFERENCES author(id) ON UPDATE CASCADE ON DELETE CASCADE,
 FOREIGN KEY(fk_genre_id) REFERENCES genre(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE member (
 id INT UNSIGNED NOT NULL AUTO_INCREMENT,
 firstname VARCHAR(100) NOT NULL,
 lastname VARCHAR(100) NOT NULL,
 email VARCHAR(255) NOT NULL UNIQUE,
 city VARCHAR(100),
 joined_at DATE,

 PRIMARY KEY(id)
);

CREATE TABLE loan (
 id INT UNSIGNED NOT NULL AUTO_INCREMENT,
 fk_book_id INT UNSIGNED NOT NULL,
 fk_member_id INT UNSIGNED NOT NULL,
 borrowed_at DATETIME NOT NULL DEFAULT NOW(),
 returned_at DATETIME NULL,

 PRIMARY KEY(id),
 FOREIGN KEY(fk_book_id) REFERENCES book(id) ON UPDATE CASCADE ON DELETE CASCADE,
 FOREIGN KEY(fk_member_id) REFERENCES member(id) ON UPDATE CASCADE ON DELETE CASCADE
);

INSERT INTO genre (name) VALUES
 ('Fiction'), ('Science'), ('History'), ('Fantasy'), ('Poetry');

INSERT INTO author (name, country) VALUES
 ('Ada Lovelace', 'UK'),
 ('Jules Verne', 'France'),
 ('Mary Shelley', 'UK'),
 ('Haruki Murakami', 'Japan'),
 ('Chinua Achebe', 'Nigeria');

INSERT INTO book (fk_author_id, fk_genre_id, title, published_year, price) VALUES
 (2, 2, 'Journey to the Center', 1864, 14.90),
 (2, 1, 'Around the World', 1872, 12.50),
 (3, 4, 'Frankenstein', 1818, 9.90),
 (4, 1, 'Norwegian Wood', 1987, 18.00),
 (4, 1, 'Kafka on the Shore', 2002, 19.50),
 (5, 1, 'Things Fall Apart', 1958, 13.00),
 (1, 2, 'Notes on the Engine', 1843, 24.00);

INSERT INTO member (firstname, lastname, email, city, joined_at) VALUES
 ('Anna', 'Berger', 'anna.berger@example.com', 'Zurich', '2023-01-15'),
 ('Ben', 'Frei', 'ben.frei@example.com', 'Bern', '2023-03-02'),
 ('Clara', 'Meier', 'clara.meier@example.com', 'Zurich', '2024-06-20'),
 ('David', 'Roth', 'david.roth@example.com', 'Basel', '2024-09-11'),
 ('Eva', 'Steiner', 'eva.steiner@example.com', 'Winterthur', '2025-02-01');

INSERT INTO loan (fk_book_id, fk_member_id, borrowed_at, returned_at) VALUES
 (1, 1, '2025-05-01 10:00:00', '2025-05-20 12:00:00'),
 (3, 1, '2025-06-10 14:00:00', NULL),
 (4, 2, '2025-06-15 09:30:00', NULL),
 (5, 3, '2025-06-18 16:45:00', '2025-07-01 10:00:00'),
 (2, 4, '2025-07-02 11:00:00', NULL),
 (6, 5, '2025-07-05 13:20:00', NULL);
`;

