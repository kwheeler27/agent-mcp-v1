import Database from "better-sqlite3";

export function seedDatabase(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      year INTEGER,
      genre TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      favorite_genre TEXT
    )
  `);

  const bookCount = (db.prepare("SELECT COUNT(*) as cnt FROM books").get() as { cnt: number }).cnt;
  if (bookCount === 0) {
    const insert = db.prepare("INSERT INTO books (title, author, year, genre) VALUES (?, ?, ?, ?)");
    const books = [
      ["To Kill a Mockingbird", "Harper Lee", 1960, "Fiction"],
      ["1984", "George Orwell", 1949, "Dystopian"],
      ["The Great Gatsby", "F. Scott Fitzgerald", 1925, "Fiction"],
      ["Neuromancer", "William Gibson", 1984, "Science Fiction"],
      ["The Hobbit", "J.R.R. Tolkien", 1937, "Fantasy"],
      ["Pride and Prejudice", "Jane Austen", 1813, "Romance"],
      ["The Left Hand of Darkness", "Ursula K. Le Guin", 1969, "Science Fiction"],
      ["Brave New World", "Aldous Huxley", 1932, "Dystopian"],
    ];
    const insertMany = db.transaction((rows: unknown[][]) => {
      for (const row of rows) insert.run(...row);
    });
    insertMany(books);
  }

  const userCount = (db.prepare("SELECT COUNT(*) as cnt FROM users").get() as { cnt: number }).cnt;
  if (userCount === 0) {
    const insert = db.prepare("INSERT INTO users (name, email, favorite_genre) VALUES (?, ?, ?)");
    const users = [
      ["Alice Johnson", "alice@example.com", "Science Fiction"],
      ["Bob Smith", "bob@example.com", "Fiction"],
      ["Carol Williams", "carol@example.com", "Fantasy"],
      ["Dave Brown", "dave@example.com", "Dystopian"],
      ["Eve Davis", "eve@example.com", "Romance"],
    ];
    const insertMany = db.transaction((rows: unknown[][]) => {
      for (const row of rows) insert.run(...row);
    });
    insertMany(users);
  }
}
