// Import jsftp in puter

(async () => {
  const ftp = new window.jsftp({
    host: 'cygwin.mirror.rafal.ca',
    port: 21,
    user: 'ftp',
    pass: 'email@example.com',
  });

  try {
    // Authenticate
    console.log('Authenticating... ');
    await ftp.auth();

    // List files in the root directory
    console.log('Listing files...');
    const fileList = await ftp.list('.');
    console.log('Files:', fileList);
    await ftp.put(new TextEncoder().encode("Testing puter-ftp"), "/hello.txt");
  } catch (error) {
    console.error('An error occurred:', error);
  } finally {
    // Clean up
    ftp.destroy();
    console.log('FTP connection closed.');
  }
})();

// module.exports = require("./lib/jsftp.js");
