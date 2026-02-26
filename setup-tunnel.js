#!/usr/bin/env node

/**
 * Cloudflare Tunnel Setup Helper
 * 
 * Automated setup of Cloudflare Tunnel for secure Hyperdrive access
 * 
 * Usage:
 *   node setup-tunnel.js
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function prompt(question) {
  return new Promise(resolve => {
    rl.question(question, resolve);
  });
}

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  const icons = {
    'INFO': '📘',
    'SUCCESS': '✅',
    'ERROR': '❌',
    'SECTION': '═══',
    'WARN': '⚠️'
  };
  console.log(`[${timestamp}] ${icons[level] || '●'} ${message}`);
}

async function checkCloudflared() {
  log('Checking if cloudflared is installed...', 'SECTION');
  try {
    const { stdout } = await execAsync('cloudflared --version');
    log(`Found: ${stdout.trim()}`, 'SUCCESS');
    return true;
  } catch (error) {
    log('cloudflared not found', 'ERROR');
    console.log('\n📥 Install cloudflared from: https://developers.cloudflare.com/cloudflare-one/connections/connect-applications/install-and-setup/installation/\n');
    return false;
  }
}

async function generateTunnelConfig(domain) {
  log('Generating tunnel configuration...', 'SECTION');
  
  const config = `# Cloudflare Tunnel Configuration for Hyperdrive
# Generated: ${new Date().toISOString()}

tunnel: hyperdrive-tunnel
credentials-file: ~/.cloudflared/cert.pem

# Enable debug logging (remove for production)
loglevel: info

# Tunnel ingress rules
ingress:
  # MySQL Hyperdrive - exposed through secure tunnel
  - hostname: mysql.${domain}
    service: tcp://localhost:3306
    
  # Optional: Your Worker API (if running locally)
  # - hostname: api.${domain}
  #   service: http://localhost:8787
  
  # Catch-all rule
  - service: http_status:404
`;
  
  const configPath = path.join(process.cwd(), 'tunnel-config.yaml');
  fs.writeFileSync(configPath, config, 'utf8');
  log(`Configuration written to: ${configPath}`, 'SUCCESS');
  
  return configPath;
}

async function generatePowerShellScript(domain) {
  log('Generating PowerShell launcher script...', 'SECTION');
  
  const script = `# Cloudflare Tunnel Launcher - Windows PowerShell
# Run this to start your secure Hyperdrive tunnel

Write-Host "🔷 Starting Cloudflare Tunnel for Hyperdrive" -ForegroundColor Cyan
Write-Host ""
Write-Host "Tunnel: hyperdrive-tunnel" -ForegroundColor Green
Write-Host "MySQL will be exposed at: mysql.${domain}" -ForegroundColor Green
Write-Host ""

# Start the tunnel
cloudflared tunnel run hyperdrive-tunnel

# To run as service instead, use (requires admin):
# cloudflared service install
# cloudflared service start
`;
  
  const scriptPath = path.join(process.cwd(), 'start-tunnel.ps1');
  fs.writeFileSync(scriptPath, script, 'utf8');
  log(`PowerShell script written to: ${scriptPath}`, 'SUCCESS');
  
  return scriptPath;
}

async function generateBashScript(domain) {
  log('Generating Bash launcher script...', 'SECTION');
  
  const script = `#!/bin/bash

# Cloudflare Tunnel Launcher - Linux/macOS
# Run this to start your secure Hyperdrive tunnel

echo "🔷 Starting Cloudflare Tunnel for Hyperdrive"
echo ""
echo "Tunnel: hyperdrive-tunnel"
echo "MySQL will be exposed at: mysql.${domain}"
echo ""

# Start the tunnel
cloudflared tunnel run hyperdrive-tunnel

# To run as service, use:
# sudo cloudflared service install
# sudo cloudflared service start
`;
  
  const scriptPath = path.join(process.cwd(), 'start-tunnel.sh');
  fs.writeFileSync(scriptPath, script, 'utf8');
  fs.chmodSync(scriptPath, '755');
  log(`Bash script written to: ${scriptPath}`, 'SUCCESS');
  
  return scriptPath;
}

async function generateTestScript(domain) {
  log('Generating test script...', 'SECTION');
  
  const script = `#!/usr/bin/env node

/**
 * Test MySQL connection through Cloudflare Tunnel
 * 
 * Make sure:
 * 1. Cloudflare Tunnel is running (start-tunnel.sh or start-tunnel.ps1)
 * 2. DNS is configured (mysql.${domain})
 * 3. MySQL credentials are correct
 */

const mysql = require('mysql2/promise');

async function testTunnel() {
  console.log('🔷 Testing Hyperdrive through Cloudflare Tunnel\\n');
  
  const config = {
    host: 'mysql.${domain}',
    port: 3306,
    user: 'sorhaaana',
    password: process.env.MYSQL_PASSWORD || 'your_password_here',
    database: 'sorha_aana'
  };
  
  console.log('📋 Connection Details:');
  console.log('   Host:', config.host);
  console.log('   Port:', config.port);
  console.log('   User:', config.user);
  console.log('   Database:', config.database);
  console.log('');
  
  try {
    console.log('⏳ Connecting through tunnel...\\n');
    const connection = await mysql.createConnection(config);
    
    console.log('✅ Connected through Cloudflare Tunnel!\\n');
    
    // Test query
    const [rows] = await connection.execute('SELECT DATABASE() as db, USER() as user, VERSION() as version;');
    
    console.log('📊 Database Info:');
    console.table(rows);
    
    // Count tables
    const [tableCount] = await connection.execute("SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = DATABASE();");
    console.log('Tables in database:', tableCount[0].count);
    
    await connection.end();
    
    console.log('\\n✅ Test successful! Your Hyperdrive is accessible through the tunnel.');
    
  } catch (error) {
    console.error('\\n❌ Connection failed:', error.message);
    console.log('\\n📝 Troubleshooting:');
    console.log('   1. Is the tunnel running? (check start-tunnel.sh/ps1)');
    console.log('   2. Is DNS configured? (mysql.${domain})');
    console.log('   3. Are credentials correct?');
    console.log('   4. Can you ping the tunnel host?');
    process.exit(1);
  }
}

testTunnel();
`;
  
  const scriptPath = path.join(process.cwd(), 'test-tunnel.js');
  fs.writeFileSync(scriptPath, script, 'utf8');
  log(`Test script written to: ${scriptPath}`, 'SUCCESS');
  
  return scriptPath;
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║   🔷 Cloudflare Tunnel Setup for Hyperdrive 🔷         ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  
  // Check cloudflared
  const hasCloudflared = await checkCloudflared();
  
  if (!hasCloudflared) {
    log('Please install cloudflared first', 'ERROR');
    rl.close();
    process.exit(1);
  }
  
  console.log('');
  
  // Get domain
  const domain = await prompt('Enter your Cloudflare domain (e.g., example.com): ');
  
  if (!domain) {
    log('Domain is required', 'ERROR');
    rl.close();
    process.exit(1);
  }
  
  console.log('');
  
  try {
    // Generate config file
    await generateTunnelConfig(domain);
    
    console.log('');
    
    // Detect OS and generate appropriate launcher
    if (process.platform === 'win32') {
      await generatePowerShellScript(domain);
    } else {
      await generateBashScript(domain);
    }
    
    console.log('');
    
    // Generate test script
    await generateTestScript(domain);
    
    console.log('');
    console.log('═'.repeat(56));
    log('Setup complete!', 'SUCCESS');
    console.log('═'.repeat(56) + '\n');
    
    console.log('📝 Next steps:\n');
    
    if (process.platform === 'win32') {
      console.log('1. Authenticate with Cloudflare:');
      console.log('   cloudflared login\n');
      
      console.log('2. Create the tunnel:');
      console.log('   cloudflared tunnel create hyperdrive-tunnel\n');
      
      console.log('3. Configure DNS (in Cloudflare dashboard):');
      console.log(`   Add CNAME record: mysql.${domain} → <tunnel-id>.cfargotunnel.com\n`);
      
      console.log('4. Start the tunnel:');
      console.log('   .\\.\\start-tunnel.ps1\n');
      
      console.log('5. Test the connection (in another terminal):');
      console.log('   node test-tunnel.js\n');
    } else {
      console.log('1. Authenticate with Cloudflare:');
      console.log('   cloudflared login\n');
      
      console.log('2. Create the tunnel:');
      console.log('   cloudflared tunnel create hyperdrive-tunnel\n');
      
      console.log('3. Configure DNS (in Cloudflare dashboard):');
      console.log(`   Add CNAME record: mysql.${domain} → <tunnel-id>.cfargotunnel.com\n`);
      
      console.log('4. Start the tunnel:');
      console.log('   ./start-tunnel.sh\n');
      
      console.log('5. Test the connection (in another terminal):');
      console.log('   node test-tunnel.js\n');
    }
    
    console.log('📚 For more details, see: CLOUDFLARE_TUNNEL_SETUP.md\n');
    
    rl.close();
    
  } catch (error) {
    log('Setup failed: ' + error.message, 'ERROR');
    rl.close();
    process.exit(1);
  }
}

main();
