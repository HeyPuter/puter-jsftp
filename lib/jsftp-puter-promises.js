/* vim:set ts=2 sw=2 sts=2 expandtab */
/*global require: true module: true */
/*
 * @package jsftp
 * @copyright Copyright(c) 2012 Ajax.org B.V. <info@c9.io>
 * @author Sergi Mansilla <sergi.mansilla@gmail.com>
 * @license https://github.com/sergi/jsFTP/blob/master/LICENSE MIT License
 */

"use strict";

// const { createConnection } = require("net");
const { EventEmitter } = require("events");
const { inherits } = require("util");
const { Readable } = require("stream");
const fs = require("fs").promises;
const combine = require("stream-combiner");

const ResponseParser = require("ftp-response-parser");
const ListingParser = require("parse-listing");
const { nfc } = require("unorm");
const path = require("path");

// const debug = require("debug")("jsftp:general");
const debug = (object) => {
    // console.error("jsftp:general ", object)
}
// const dbgCommand = require("debug")("jsftp:command");
const dbgCommand = (object) => {
    // console.error("jsftp:command ", object)
}
// const dbgResponse = require("debug")("jsftp:response");
const dbgResponse = (object) => {
    // console.error("jsftp:response ", object)
}

const FTP_HOST = "localhost";
const FTP_PORT = 21;
const TIMEOUT = 10 * 60 * 1000;
const IDLE_TIME = 30000;

const expectedMarks = {
  marks: [125, 150],
  ignore: 226
};

const RE_PASV = /([-\d]+,[-\d]+,[-\d]+,[-\d]+),([-\d]+),([-\d]+)/;
const FTP_NEWLINE = /\r\n|\n/;

async function runCmd(name, ...params) {
  let completeCmd = name + " ";
  
  // Check if last parameter is a function (for backward compatibility)
  if (typeof params[params.length - 1] === "function") {
    params.pop(); // Remove callback
  }

  completeCmd += params.join(" ");
  return this.execute(completeCmd.trim());
}

class Ftp extends EventEmitter {
  constructor(cfg) {
    super();
    
    this.host = cfg.host || FTP_HOST;
    this.port = cfg.port || FTP_PORT;
    this.user = cfg.user || "anonymous";
    this.pass = cfg.pass || "@anonymous";
    this.createSocket = cfg.createSocket;
    this.useList = cfg.useList || false;

    this.commandQueue = [];

    this.on("data", dbgResponse);
    this.on("error", dbgResponse);

    this._createSocket(this.port, this.host);
  }

  reemit(event) {
    return data => {
      this.emit(event, data);
      debug(`event:${event}`, data || {});
    };
  }

  _createSocket(port, host, firstAction = () => {}) {
    if (this.socket && this.socket.destroy) {
      this.socket.destroy();
    }

    if (this.resParser) {
      this.resParser.end();
    }
    this.resParser = new ResponseParser();

    this.authenticated = false;
    this.socket = new puter.net.Socket(host, port);
    this.socket.on("open", this.reemit("connect"));
    // this.socket.on("timeout", this.reemit("timeout"));

    this.socket.on("data", (data) => {
      this.resParser.write(Buffer.from(data.buffer));
    })

    this.resParser.on("data", data => {
      this.emit("data", data);
      dbgResponse(data.text);
      this.parseResponse(data);
    });
    this.resParser.on("error", this.reemit("error"));
    firstAction()

  }

  parseResponse(response) {
    if (this.commandQueue.length === 0) {
      return;
    }
    if ([220].indexOf(response.code) > -1) {
      return;
    }

    const next = this.commandQueue[0].resolve;
    if (response.isMark) {
      if (
        !next.expectsMark ||
        next.expectsMark.marks.indexOf(response.code) === -1
      ) {
        return;
      }

      if (next.expectsMark.ignore) {
        this.ignoreCmdCode = next.expectsMark.ignore;
      }
    }

    if (this.ignoreCmdCode === response.code) {
      this.ignoreCmdCode = null;
      return;
    }

    this.parse(response, this.commandQueue.shift());
  }

  send(command) {
    if (!command) {
      return;
    }

    dbgCommand(command);
    this.socket.write(command + "\r\n");
  }

  nextCmd() {
    const cmd = this.commandQueue[0];
    if (!this.inProgress && cmd) {
      this.send(cmd.action);
      this.inProgress = true;
    }
  }

  async execute(action) {
    return new Promise((resolve, reject) => {
      if (this.socket) {
        return this.runCommand({ action, resolve, reject });
      }

      this.authenticated = false;
      this._createSocket(this.port, this.host, () => {
        this.runCommand({ action, resolve, reject });
      });
    });
  }

  runCommand(cmd) {
    if (this.authenticated || /^(feat|syst|user|pass)/.test(cmd.action)) {
      this.commandQueue.push(cmd);
      this.nextCmd();
      return;
    }

    this.getFeatures().then(() => {
      this.auth(this.user, this.pass).then(() => {
        this.commandQueue.push(cmd);
      });
    });
  }

  parse(response, command) {
    this.inProgress = false;
    if (response.isError) {
      const err = new Error(response.text || "Unknown FTP error.");
      err.code = response.code;
      command.reject(err);
    } else {
      command.resolve(response);
    }
    this.nextCmd();
  }

  getPasvPort(text) {
    const match = RE_PASV.exec(text);
    if (!match) {
      return null;
    }

    let host = match[1].replace(/,/g, ".");
    if (host === "127.0.0.1" || host === "0.0.0.0") {
      host = this.host;
    }

    return {
      host,
      port: (parseInt(match[2], 10) & 255) * 256 + (parseInt(match[3], 10) & 255)
    };
  }

  hasFeat(feature) {
    return !!feature && this.features.indexOf(feature.toLowerCase()) > -1;
  }

  _parseFeats(features) {
    const featureLines = features.split(FTP_NEWLINE).slice(1, -1);
    return featureLines
      .map(feat => feat.trim().toLowerCase())
      .filter(feat => !!feat);
  }

  async getFeatures() {
    if (this.features) {
      return this.features;
    }

    const featResponse = await this.raw("feat");
    this.features = this._parseFeats(featResponse.text);
    
    try {
      const sysResponse = await this.raw("syst");
      if (sysResponse.code === 215) {
        this.system = sysResponse.text.toLowerCase();
      }
    } catch (err) {
      // System command failed, continue without system info
    }

    return this.features;
  }

  async auth(user, pass) {
    if (this.authenticating === true) {
      throw new Error("This client is already authenticating");
    }

    if (typeof user !== "string") {
      user = this.user;
    }
    if (typeof pass !== "string") {
      pass = this.pass;
    }

    this.authenticating = true;
    try {
      const userRes = await this.raw("user", user);
      if ([230, 331, 332].indexOf(userRes.code) === -1) {
        throw new Error("Invalid username");
      }

      const passRes = await this.raw("pass", pass);
      if ([230, 202].indexOf(passRes.code) > -1) {
        this.authenticated = true;
        this.user = user;
        this.pass = pass;
        await this.raw("type", "I");
        return passRes;
      } else if (passRes.code === 332) {
        await this.raw("acct", ""); // ACCT not really supported
      } else {
        throw new Error("Invalid password");
      }
    } finally {
      this.authenticating = false;
    }
  }

  async setType(type) {
    type = type.toUpperCase();
    if (this.type === type) {
      return;
    }

    const response = await this.raw("type", type);
    this.type = type;
    return response;
  }

  async list(path = "") {
    return new Promise((resolve, reject) => {
      let listing = "";
      this.getPasvSocket()
        .then(socket => {
          // socket.setEncoding("utf8");
          const dec = new TextDecoder("utf8");

          socket.on("data", data => {
            listing += dec.decode(data, {stream: true});
          });
          
          const dec2 = new TextDecoder("utf8");
          let done = false;

          const hackyCloseHandler = (data) => {
            if (dec2.decode(data).startsWith("226") && !done) {
              done = true;
              resolve(listing);
              this.socket.off("data", hackyCloseHandler);
            }
          }
          this.socket.on("data", hackyCloseHandler);
          
          // this.pasvTimeout(socket, reject);

          socket.on("close", ()=> {
            if (!done) {
              done = true;
              reject(new Error("Failed to resolve list before socket close"))
            }
            if (this.socket)
              this.socket.off("data", hackyCloseHandler);

            // resolve(listing); // HackyCloseHandler seems more reliable
          });
          socket.on("error", reject);

          const cmdCallback = (err, res) => {
            if (err) {
              return reject(err);
            }

            const isExpectedMark = expectedMarks.marks.some(
              mark => mark === res.code
            );

            if (!isExpectedMark) {
              reject(
                new Error(
                  `Expected marks ${expectedMarks.toString()} instead of: ${res.text}`
                )
              );
            }
          };

          cmdCallback.expectsMark = expectedMarks;

          this.execute(`list ${path}`, cmdCallback);
        })
        .catch(reject);
    });
  }

  emitProgress(data) {
    this.emit("progress", {
      filename: data.filename,
      action: data.action,
      total: data.totalSize || 0,
      transferred:
        data.socket[data.action === "get" ? "bytesRead" : "bytesWritten"]
    });
  }

  async get(remotePath) {
    const buffer = []
    const dataSocket = await this.getGetSocket(remotePath);

    dataSocket.on("data", (data) => {
      buffer.push(data);
    })
    let done = false;

    return new Promise((res, rej)=> {

      const dec2 = new TextDecoder();
      const hackyCloseHandler = (data) => {
        if (dec2.decode(data).startsWith("226") && !done) {
          done = true;
          res(new File(buffer, path.basename(remotePath)));
          this.socket.off("data", hackyCloseHandler);
          dataSocket.close();
        }
      }
      this.socket.on("data", hackyCloseHandler);

      
      dataSocket.on("error", (reason)=> {
        rej(reason);
        done = true;
      })
      // Commented out because HackyCloseHandler seems more reliable ironically. Occasionally this will return a 0b file, pretty useless
      // dataSocket.on("close", async(reason)=> {
      //   if (!done) {
      //     res(new File(buffer, path.basename(remotePath)));
      //   }
      // })
    })
  }

  async getGetSocket(path) {
    const socket = await this.getPasvSocket();
    
    return new Promise(async (resolve, reject) => {
      socket.on("error", err => {
        if (err.code === "ECONNREFUSED") {
          err.msg = "Probably trying a PASV operation while one is in progress";
        }
        console.error("got an error")
        reject(err);
      });
      resolve(socket);
      const res = await this.execute("retr " + path);
      // this.pasvTimeout(socket, reject);
      // socket.pause();
    });
  }

  async put(from, destination) {
    const putReadable = async (from, to, totalSize) => {
      from.on("readable", () => {
        this.emitProgress({
          filename: to,
          action: "put",
          socket: from,
          totalSize
        });
      });

      return this.getPutSocket(from, to);
    };

    if (from instanceof Buffer) {
      return this.getPutSocket(from, destination);
    } else if (typeof from === "string") {
      try {
        const stats = await fs.stat(from);
        if (stats.isDirectory()) {
          throw new Error("Local path cannot be a directory");
        }

        const totalSize = stats.size;
        return putReadable(fs.createReadStream(from), destination, totalSize);
      } catch (err) {
        if (err.code === "ENOENT") {
          throw new Error("Local file doesn't exist.");
        }
        throw err;
      }
    } else if (from instanceof Readable) {
      return putReadable(from, destination, 0);
    } else {
      throw new Error("Expected `from` parameter to be a Buffer, Stream, or a String");
    }
  }

  async getPutSocket(from, path) {
    const socket = await this.getPasvSocket();
    
    return new Promise((resolve, reject) => {
      socket.on("close", resolve);
      socket.on("error", reject);

      const callback = (err, res) => {
        if (err) {
          if (socket) {
            socket.destroy();
          }
          return reject(err);
        }

        if (res.code === 125 || res.code === 150) {
          this.pasvTimeout(socket, reject);
          if (from instanceof Buffer) {
            socket.end(from);
          } else if (from instanceof Readable) {
            from.pipe(socket);
          }
        } else {
          if (socket) {
            socket.destroy();
          }
          return reject(new Error("Unexpected command " + res.text));
        }
      };

      callback.expectsMark = expectedMarks;

      this.execute(`stor ${path}`, callback);
    });
  }

  pasvTimeout(socket, reject) {
    // socket.once("timeout", () => {
    //   debug("PASV socket timeout");
    //   this.emit("timeout");
    //   socket.end();
    //   reject(new Error("Passive socket timeout"));
    // });
  }

  async getPasvSocket() {
    const res = await this.execute("pasv");
    
    const options = this.getPasvPort(res.text);
    if (!options) {
      throw new Error("Bad passive host/port combination");
    }

    const socket = (this._pasvSocket = new puter.net.Socket(options.host, options.port));
    // socket.setTimeout(this.timeout || TIMEOUT);
    socket.on("close", () => {
      this._pasvSocket = undefined;
    });

    return socket;
  }

  async ls(filePath) {
    const parseEntries = async (entries) => {
      return new Promise((resolve, reject) => {
        ListingParser.parseFtpEntries(entries.text || entries, (err, files) => {
          if (err) {
            reject(err);
          } else {
            files.forEach(file => {
              file.name = nfc(file.name);
            });
            resolve(files);
          }
        });
      });
    };

    if (this.useList) {
      const entries = await this.list(filePath);
      return parseEntries(entries);
    } else {
      try {
        const data = await this.raw("stat", filePath);
        return parseEntries(data);
      } catch (err) {
        const errored = err && (err.code === 502 || err.code === 500);
        const isHummingbird = this.system && this.system.indexOf("hummingbird") > -1;
        
        if (errored || isHummingbird) {
          this.useList = true;
          const entries = await this.list(filePath);
          return parseEntries(entries);
        } else {
          throw err;
        }
      }
    }
  }

  async rename(from, to) {
    await this.raw("rnfr", from);
    return this.raw("rnto", to);
  }

  keepAlive(wait) {
    if (this._keepAliveInterval) {
      clearInterval(this._keepAliveInterval);
    }

    this._keepAliveInterval = setInterval(
      () => this.raw("noop"),
      wait || IDLE_TIME
    );
  }

  destroy() {
    if (this._keepAliveInterval) {
      clearInterval(this._keepAliveInterval);
    }

    if (this.socket && this.socket.writable) {
      this.socket.end();
    }

    if (this._pasvSocket && this._pasvSocket.writable) {
      this._pasvSocket.end();
    }

    this.resParser.end();

    this.socket = undefined;
    this._pasvSocket = undefined;

    this.features = null;
    this.authenticated = false;
  }

  // Add async raw method to handle commands
  async raw(...args) {
    return runCmd.apply(this, args);
  }
}

module.exports = Ftp;