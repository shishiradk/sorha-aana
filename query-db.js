#!/usr/bin/env node

// query-db.js
// Simple script to run SQL queries against MySQL database
// Usage: node query-db.js
// Then enter your SQL query at the prompt

const mysql = require('mysql2/promise');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function prompt(question) {
  return new Promise(resolve => {
    rl.question(question, resolve);
  });
}

async function main() {
  try {
    console.log('🔍 MySQL Database Query Tool\n');

    // Get connection details from user
    const host = await prompt('MySQL Host (default: mysql.neptechpal.com.np): ');
    const port = await prompt('MySQL Port (default: 3306): ');
    const user = await prompt('MySQL Username: ');
    const password = await prompt('MySQL Password: ');
    const database = await prompt('Database Name (default: sorha-aana): ');

    // Use defaults if not provided
    const config = {
      host: host || 'mysql.neptechpal.com.np',
      port: parseInt(port) || 3306,
      user: user || 'root',
      password: password,
      database: database || 'sorha-aana'
    };

    console.log('\n🔗 Connecting to database...');
    const connection = await mysql.createConnection(config);
    console.log('✅ Connected!\n');

    // Interactive query loop
    let running = true;
    while (running) {
      console.log('\n' + '='.repeat(80));
      console.log('Enter your SQL query (or type "exit" to quit, "show tables" for list):');
      console.log('='.repeat(80));
      
      const sql = await prompt('\nSQL> ');

      if (sql.toLowerCase() === 'exit') {
        running = false;
        break;
      }

      if (!sql.trim()) {
        console.log('Please enter a valid SQL query');
        continue;
      }

      try {
        console.log('\n⏳ Executing query...\n');
        const [rows, fields] = await connection.execute(sql);

        if (rows.length === 0) {
          console.log('✅ Query executed successfully. (0 rows)');
        } else {
          console.log(`✅ Query executed successfully. (${rows.length} rows)\n`);
          
          // Display as table
          if (Array.isArray(rows) && rows.length > 0) {
            console.table(rows);
          } else {
            console.log(JSON.stringify(rows, null, 2));
          }
        }

      } catch (queryError) {
        console.error('❌ Query Error:', queryError.message);
      }
    }

    await connection.end();
    console.log('\n👋 Connection closed. Goodbye!');
    rl.close();

  } catch (error) {
    console.error('❌ Error:', error.message);
    rl.close();
    process.exit(1);
  }
}

main();
