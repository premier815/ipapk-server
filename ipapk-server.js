#!/usr/bin/env node

var fs = require('fs-extra');
var https = require('https');
var path = require('path');
var exit = process.exit;
var pkg = require('./package.json');
var version = pkg.version;
var AdmZip = require("adm-zip");
var program = require('commander');
var express = require('express');
var mustache = require('mustache');
var strftime = require('strftime');
var underscore = require('underscore');
var os = require('os');
var multiparty = require('multiparty');
var sqlite3 = require('sqlite3');  
var uuidV4 = require('uuid/v4');
var extract = require('ipa-extract-info');
var apkParser3 = require("apk-parser3");
var url = require('url');
//var exec = require('child_process');
require('shelljs/global');

/** 格式化输入字符串**/

//用法: "hello{0}".format('world')；返回'hello world'

String.prototype.format= function(){
  var args = arguments;
  return this.replace(/\{(\d+)\}/g,function(s,i){
    return args[i];
  });
}

before(program, 'outputHelp', function() {
  this.allowUnknownOption();
});

program
    .version(version)
    .usage('[option] [dir]')
    .option('-p, --port <port-number>', 'set port for server (defaults is 1234)')
    .option('-h, --host <host>', 'set host for server (defaults is your LAN ip)')
    .parse(process.argv);

var port = program.port || 1234;

var ipAddress = program.host || underscore
  .chain(require('os').networkInterfaces())
  .values()
  .flatten()
  .find(function(iface) {
    return iface.family === 'IPv4' && iface.internal === false;
  })
  .value()
  .address;

var pageCount = 5;
var serverDir = os.homedir() + "/.ipapk-server/"
var globalCerFolder = serverDir + ipAddress;
var ipasDir = serverDir + "ipa";
var apksDir = serverDir + "apk";
var iconsDir = serverDir + "icon";
createFolderIfNeeded(serverDir)
createFolderIfNeeded(ipasDir)
createFolderIfNeeded(apksDir)
createFolderIfNeeded(iconsDir)
function createFolderIfNeeded (path) {
  if (!fs.existsSync(path)) {  
    fs.mkdirSync(path, function (err) {
        if (err) {
            console.log(err);
            return;
        }
    });
  }
}

function excuteDB(cmd, params, callback) {
  var db = new sqlite3.Database(serverDir + 'db.sqlite3');
  db.run(cmd, params, callback);
  db.close();
}

function queryDB(cmd, params, callback) {
  var db = new sqlite3.Database(serverDir + 'db.sqlite3');
  db.all(cmd, params, callback);
  db.close();
}

excuteDB("CREATE TABLE IF NOT EXISTS info (\
  id integer PRIMARY KEY autoincrement,\
  guid TEXT,\
  bundleID TEXT,\
  version TEXT,\
  build TEXT,\
  name TEXT,\
  uploadTime datetime default (datetime('now', 'localtime')),\
  platform TEXT,\
  changelog TEXT\
  )");
/**
 * Main program.
 */
process.exit = exit

// CLI
var basePath = "https://{0}:{1}".format(ipAddress, port);
if (!exit.exited) {
  main();
}

/**
 * Install a before function; AOP.
 */

function before(obj, method, fn) {
  var old = obj[method];

  obj[method] = function() {
    fn.call(this);
    old.apply(this, arguments);
  };
}

function main() {

  console.log(basePath);

  var key;
  var cert;

  try {
    key = fs.readFileSync(globalCerFolder + '/mycert1.key', 'utf8');
    cert = fs.readFileSync(globalCerFolder + '/mycert1.cer', 'utf8');
  } catch (e) {
    var result = exec('sh  ' + path.join(__dirname, 'bin', 'generate-certificate.sh') + ' ' + ipAddress).output;
    key = fs.readFileSync(globalCerFolder + '/mycert1.key', 'utf8');
    cert = fs.readFileSync(globalCerFolder + '/mycert1.cer', 'utf8');
  }

  var options = {
    key: key,
    cert: cert
  };

  var app = express();
  app.use('/cer', express.static(globalCerFolder));
  app.use('/', express.static(path.join(__dirname,'web')));
  app.use('/ipa', express.static(ipasDir));
  app.use('/apk', express.static(apksDir));
  app.use('/icon', express.static(iconsDir));
  app.get(['/apps/:platform', '/apps/:platform/:page'], function(req, res, next) {
  	  res.set('Access-Control-Allow-Origin','*');
      res.set('Content-Type', 'application/json');
      var page = parseInt(req.params.page ? req.params.page : 1);
      if (req.params.platform === 'android' || req.params.platform === 'ios') {
        queryDB("select * from info where platform=? group by bundleID order by uploadTime desc limit ?,?", [req.params.platform, (page - 1) * pageCount, page * pageCount], function(error, result) {
          if (result) {
            res.send(mapIconAndUrl(result))
          } else {
            errorHandler(error, res)
          }
        })
      }
  });

  app.get(['/apps/:platform/:bundleID', '/apps/:platform/:bundleID/:page'], function(req, res, next) {
  	  res.set('Access-Control-Allow-Origin','*');
      res.set('Content-Type', 'application/json');
      var page = parseInt(req.params.page ? req.params.page : 1);
      if (req.params.platform === 'android' || req.params.platform === 'ios') {
        queryDB("select * from info where platform=? and bundleID=? order by uploadTime desc limit ?,? ", [req.params.platform, req.params.bundleID, (page - 1) * pageCount, page * pageCount], function(error, result) {
          if (result) {
            res.send(mapIconAndUrl(result))
          } else {
            errorHandler(error, res)
          }
        })
      }
  });

  // 按平台、bundleID加日期删除历史包，默认删除30天之前的
  app.delete(['/apps/:platform', '/apps/:platform/:date', '/apps/:platform/:bundleID', '/apps/:platform/:bundleID/:date'], function(req, res, next) {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Content-Type', 'application/json');
      var nowtimeStamp = Date.parse(new Date());
      var aMonthStamp = 30 * 24 * 60 * 60 * 1000;
      var deadDateStamp = new Date(nowtimeStamp - aMonthStamp);
      var year = deadDateStamp.getFullYear();
      var month = deadDateStamp.getMonth() + 1;
      var day = deadDateStamp.getDate();
      if (month < 10) {
          month = "0{0}".format(month);
      }
      if (day < 10) {
          day = "0{0}".format(day);
      }

      var date = req.params.date;
      if (date == undefined) {
          var date = "{0}-{1}-{2}".format(year, month, day);
      } else if (date.indexOf('.') != -1) {
          var date = "{0}-{1}-{2}".format(year, month, day);
      } else {
          var date = date;
          date = date.split('-');
          if (date[1].length < 2 && Number(date[1]) < 10) {
              month = "0{0}".format(date[1]);
          } else {
              month = "{0}".format(date[1]);
          }
          if (date[2].length < 2 && Number(date[2]) < 10) {
              day = "0{0}".format(date[2]);
          } else {
              day = "{0}".format(date[2]);
          }
          var date = "{0}-{1}-{2}".format(year, month, day);
      }

      if (req.params.platform === 'android' || req.params.platform === 'ios') {
          if (req.params.bundleID != undefined) {
              var selSql = "select guid from info where platform=? and bundleID=? and uploadTime < ? ";
              var delSql = "delete from info where platform=? and bundleID=? and uploadTime < ? ";
              var paramsList = [req.params.platform, req.params.bundleID, date];
          } else if (req.params.date != undefined && req.params.bundleID == undefined) {
              if (req.params.date.indexOf('.') != -1) {
                  var bundleId = req.params.date;
                  var selSql = "select guid from info where platform=? and bundleID=? and uploadTime < ? ";
                  var delSql = "delete from info where platform=? and bundleID=? and uploadTime < ? ";
                  var paramsList = [req.params.platform, bundleId, date];
              } else {
                  var selSql = "select guid from info where platform=? and uploadTime < ? ";
                  var delSql = "delete from info where platform=? and uploadTime < ? ";
                  var paramsList = [req.params.platform, date];
              }
          } else {
              var selSql = "select guid from info where platform=? and uploadTime < ? ";
              var delSql = "delete from info where platform=? and uploadTime < ? ";
              var paramsList = [req.params.platform, date];
          }
      }

      // 查询出要删除的包
      queryDB(selSql, paramsList, function(error,result) {
          counts = result.length;
          if(counts != 0) {
            for (i = 0; i < result.length; i++) {
                var guid = result[i]['guid'];
                var cmd = 'find ' + serverDir + ' -name ' + guid + '*' + ' | xargs -r rm -f'
                exec(cmd, {encoding: 'utf8'}, function (err, stdout, stderr) {
                    if (err) {
                        console.log(err);
                    }
                });
            }
            // 删除包
            excuteDB(delSql, paramsList, function(error) {
                if (!error) {
                        console.log("delete success");
                        res.status(200);
                        res.send("delete success");
                    }else {
                        console.log(error);
                        res.status(500);
                        res.send(error);
                    }
            })
          }else {
            console.log("query result is null,not delete");
            res.status(404);
            res.send("query result is null,not delete");
          }
      });
  });

  app.get('/plist/:guid', function(req, res) {
    queryDB("select name,bundleID from info where guid=?", [req.params.guid], function(error, result) {
      if (result) {
        fs.readFile(path.join(__dirname, 'templates') + '/template.plist', function(err, data) {
            if (err) throw err;
            var template = data.toString();
            var rendered = mustache.render(template, {
              guid: req.params.guid,
              name: result[0].name,
              bundleID: result[0].bundleID,
              basePath: basePath,
            });
            res.set('Content-Type', 'text/plain; charset=utf-8');
            res.set('Access-Control-Allow-Origin','*');
            res.send(rendered);
        })
      } else {
        errorHandler(error, res)
      }
    })
  });

  app.post('/upload', function(req, res) {
    var form = new multiparty.Form();
    form.parse(req, function(err, fields, files) {
      if (err) {
        errorHandler(err, res);
        return;
      }
      var changelog;
      if (fields.changelog) {
        changelog = fields.changelog[0];
      }
      if (!files.package) {
        errorHandler("params error",res)
        return
      }
      var obj = files.package[0];
      var tmp_path = obj.path;
      parseAppAndInsertToDb(tmp_path, changelog, info => {
        storeApp(tmp_path, info["guid"], error => {
          if (error) {
            errorHandler(error,res)
          }
          console.log(info)
          res.send(info)
        })

      }, error => {
        errorHandler(error,res)
      });
    });
  });

  https.createServer(options, app).listen(port);
}

function errorHandler(error, res) {
  console.log(error)
  res.send({"error":error})
}

function mapIconAndUrl(result) {
  var items = result.map(function(item) {
    item.icon = "{0}/icon/{1}.png".format(basePath, item.guid);
    if (item.platform === 'ios') {
      item.url = "itms-services://?action=download-manifest&url={0}/plist/{1}".format(basePath, item.guid);
    } else if (item.platform === 'android') {
      item.url = "{0}/apk/{1}.apk".format(basePath, item.guid);
    }
    return item;
  })
  return items;
}

function parseAppAndInsertToDb(filePath, changelog, callback, errorCallback) {
  var guid = uuidV4();
  var parse, extract
  if (path.extname(filePath) === ".ipa") {
    parse = parseIpa
    extract = extractIpaIcon
  } else if (path.extname(filePath) === ".apk") {
    parse = parseApk
    extract = extractApkIcon
  } else {
    errorCallback("params error")
    return;
  }
  Promise.all([parse(filePath),extract(filePath,guid)]).then(values => {
    var info = values[0]
    info["guid"] = guid
    info["changelog"] = changelog
    excuteDB("INSERT INTO info (guid, platform, build, bundleID, version, name, changelog) VALUES (?, ?, ?, ?, ?, ?, ?);",
    [info["guid"], info["platform"], info["build"], info["bundleID"], info["version"], info["name"], changelog],function(error){
        if (!error){
          callback(info)
        } else {
          errorCallback(error)
        }
    });
  }, reason => {
    errorCallback(reason)
  })
}

function storeApp(fileName, guid, callback) {
  var new_path;
  if (path.extname(fileName) === ".ipa") {
    new_path = path.join(ipasDir, guid + ".ipa");
  } else if (path.extname(fileName) === ".apk") {
    new_path = path.join(apksDir, guid + ".apk");
  }
  fs.rename(fileName,new_path,callback)
}

function parseIpa(filename) {
  return new Promise(function(resolve,reject){
    var fd = fs.openSync(filename, 'r');
    extract(fd, function(err, info, raw){
    if (err) reject(err);
      var data = info[0];
      var info = {}
      info["platform"] = "ios"
      info["build"] = data.CFBundleVersion,
      info["bundleID"] = data.CFBundleIdentifier,
      info["version"] = data.CFBundleShortVersionString,
      info["name"] = data.CFBundleName
      resolve(info)
    });
  });
}

function parseApk(filename) {
  return new Promise(function(resolve,reject){
    apkParser3(filename, function (err, data) {
        var package = parseText(data.package)
        var info = {
          "name":data["application-label"].replace(/'/g,""),
          "build":package.versionCode,
          "bundleID":package.name,
          "version":package.versionName,
          "platform":"android"
        }
        resolve(info)
    });
  });
}

function parseText(text) {
  var regx = /(\w+)='([\w\.\d]+)'/g
  var match = null, result = {}
  while(match = regx.exec(text)) {
    result[match[1]] = match[2]
  }
  return result
}

function extractApkIcon(filename,guid) {
  return new Promise(function(resolve,reject){
    apkParser3(filename, function (err, data) {
      var iconPath = false;
      [640,320,240,160].every(i=>{
        if(typeof data["application-icon-"+i] !== 'undefined'){
          iconPath=data["application-icon-"+i];
          return false;
        }
        return true;
      });
      if(!iconPath){
        reject("can not find icon ");
      }

      iconPath = iconPath.replace(/'/g,"")
      var tmpOut = iconsDir + "/{0}.png".format(guid)
      var zip = new AdmZip(filename); 
      var ipaEntries = zip.getEntries();
      var found = false
      ipaEntries.forEach(function(ipaEntry) {
        if (ipaEntry.entryName.indexOf(iconPath) != -1) {
          var buffer = new Buffer(ipaEntry.getData());
          if (buffer.length) {
            found = true
            fs.writeFile(tmpOut, buffer,function(err){  
              if(err){  
                  reject(err)
              }
              resolve({"success":true})
            })
          }
        }
      })
      if (!found) {
        reject("can not find icon ")
      }
    });
  })
}

function extractIpaIcon(filename,guid) {
  return new Promise(function(resolve,reject){
    var tmpOut = iconsDir + "/{0}.png".format(guid)
    var zip = new AdmZip(filename); 
    var ipaEntries = zip.getEntries();
    var found = false;
    ipaEntries.forEach(function(ipaEntry) {
      if (ipaEntry.entryName.indexOf('AppIcon60x60@2x.png') != -1) {
        found = true;
        var buffer = new Buffer(ipaEntry.getData());
        if (buffer.length) {
          fs.writeFile(tmpOut, buffer,function(err){  
            if(err){  
              reject(err)
            } else {
              var execResult = exec(path.join(__dirname, 'bin','pngdefry -s _tmp ') + ' ' + tmpOut)
              if (execResult.stdout.indexOf('not an -iphone crushed PNG file') != -1) {
                resolve({"success":true})
              } else {
                fs.remove(tmpOut,function(err){  
                  if(err){
                    reject(err)
                  } else {
                    var tmp_path = iconsDir + "/{0}_tmp.png".format(guid)
                    fs.rename(tmp_path,tmpOut,function(err){
                      if(err){
                        reject(err)
                      } else {
                        resolve({"success":true})
                      }
                    })
                  }
                })
              }
            }
          })
        }
      }
    })
    if (!found) {
      reject("can not find icon ")
    }
  })
}
