var Repeat = require('repeat');
var redis = require("redis");
var request = require('request');
var etcdnodejs = require('nodejs-etcd');

// the kubernetes api cert in rancher is selfsigned and auto generated so we just have to ignore that when connecting to the kubernetes API
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"

var SVC_POLL_INTERVAL = process.env.SVC_POLL_INTERVAL || 15;
var ETCD_HOST = process.env.ETCD_HOST || 'localhost';
var ETCD_PORT = process.env.ETCD_PORT || '4001';
var KUBE_SELECTOR = process.env.KUBE_SELECTOR ||  'type%3Dingress';
var KUBERNETES_SERVICE_PORT = process.env.KUBERNETES_SERVICE_PORT || '8080';
var KUBERNETES_SERVICE_HOST = process.env.KUBERNETES_SERVICE_HOST || 'localhost';
var PROTOCOL = 'https';
var KUBE_API_PATH = '/api';
var KUBE_API_URL = process.env.KUBE_API_URL || 'https://'+KUBERNETES_SERVICE_HOST+':'+KUBERNETES_SERVICE_PORT+ KUBE_API_PATH;
var KUBE_API = KUBE_API_URL +'/v1/services?labelSelector='+KUBE_SELECTOR;
var KUBE_API_PODS = KUBE_API_URL +'/v1/pods';
var DOMAIN =  process.env.DOMAIN || '.service.consul';
var ENVIRONMENT_NAME = process.env.ENVIRONMENT_NAME || 'test';
var KUBE_API_USER = process.env.KUBE_API_USER || '';
var KUBE_API_PASSWORD = process.env.KUBE_API_PASSWORD || '';
var CONSUL_API_ADDRESS = process.env.CONSUL_API_ADDRESS;
var CONSUL_API_TOKEN = process.env.CONSUL_API_TOKEN;
var POD_NAME = process.env.POD_NAME;
var DOCKER_HOST_IP = process.env.DOCKER_HOST_IP;
var DOCKER_POD_IP = process.env.DOCKER_POD_IP;
var VULCAND_HOST_PORT = process.env.VULCAND_HOST_PORT || 80;

var etcd = new etcdnodejs({
    url: 'http://'+ETCD_HOST+':'+ETCD_PORT
})


// call the kubernetes API and get the list of services tagged
function checkServices() {
  console.log("requesting services from " + KUBE_API);
  
  var authObj = {user:KUBE_API_USER,pass:KUBE_API_PASSWORD};
  
  // call kubernetes API
  request({uri:KUBE_API,auth:authObj}, function (error, response, body) {
    
    if (!error && response.statusCode == 200) {
      var services = parseJSON(JSON.parse(body));
      
      console.log(services);
      
      // add service into etcd backend for vulcand
      addServiceBackends(services);
     
    } else {
        console.log('status code'+response.statusCode +'error calling kubernetes API '+error)
    }
  
  })
  
  
  
};


/*
{"kind":"ServiceList","apiVersion":"v1","metadata":{"selfLink":"/api/v1/services","resourceVersion":"2823"},
"items":[
    {"metadata":{"name":"nginx","namespace":"default","selfLink":"/api/v1/namespaces/default/services/nginx","uid":"9fb58c71-f667-11e5-93ae-02dedbe80445","resourceVersion":"106","creationTimestamp":"2016-03-30T11:07:42Z","labels":{"name":"nginx","type":"ui"}},"spec":{"ports":[{"protocol":"TCP","port":80,"targetPort":80}],"selector":{"name":"nginx"},"clusterIP":"10.43.143.209","type":"ClusterIP","sessionAffinity":"None"},"status":{"loadBalancer":{}}},{"metadata":{"name":"nginx","namespace":"test","selfLink":"/api/v1/namespaces/test/services/nginx","uid":"a2746c69-f66c-11e5-93ae-02dedbe80445","resourceVersion":"577","creationTimestamp":"2016-03-30T11:43:34Z","labels":{"name":"nginx","type":"ui"}},"spec":{"ports":[{"protocol":"TCP","port":80,"targetPort":80}],"selector":{"name":"nginx"},"clusterIP":"10.43.15.45","type":"ClusterIP","sessionAffinity":"None"},"status":{"loadBalancer":{}}}]}

*/

// Parse the JSON returned from the kubernetes service API and extract the information we need.
function parseJSON(serviceList) {
  
  var services= [];
  
  for(var i =0; i < serviceList.items.length;i++) {
    
    var service = {
      name: serviceList.items[i].metadata.name,
      namespace: serviceList.items[i].metadata.namespace,
      port: serviceList.items[i].spec.ports[0].port,
      ip: serviceList.items[i].spec.clusterIP,
      annotations: serviceList.items[i].metadata.annotations
    }
    
    services.push(service);
  }
  
  return services;
  
}

// process discovered services and add frontends and backends for the them in etcd for vulcand to route with.
function addServiceBackends(services) {
  
  // loop through any services that had a type=ui label added in their metadata
  
  for(var i = 0; i < services.length;i++) {
    
    var name = services[i].name+'-'+services[i].namespace;
    var host = name+'.'+ ENVIRONMENT_NAME +'.'+DOMAIN;
    var serviceEndpoint = 'http://'+services[i].ip + ':' + services[i].port
    var path = '/.*';
    
    if(typeof(services[i].annotations) !== 'undefined') {
      
      // allow a frontend to have a context path set for it
      if(typeof(services[i].annotations.path) !== 'undefined') {
        path = services[i].annotations.path;
      } 
    
      // allow the service to overide the host value through a label
      if(typeof(services[i].annotations.host) !== 'undefined') {
        host = services[i].annotations.host;
      } 
    }
    
    // add backend and frontend info for vulcand to read from etcd
    etcd.write({key: "/vulcand/backends/"+name+"/backend",value: '{"Type": "http"}',ttl:30}, etcdCallback);
    etcd.write({key: "/vulcand/backends/"+name+"/servers/srv1",value: '{"URL": "'+serviceEndpoint+'"}',ttl:30}, etcdCallback);
    
    var etcdvalue = {
       Type: 'http',
       BackendId: name,
       Route: 'PathRegexp("'+path+'") && Host("'+host+'")'
    }
    
    etcd.write({key: '/vulcand/frontends/'+name+'/frontend',value:JSON.stringify(etcdvalue),ttl:30}, etcdCallback);
    
    publishServiceToConsul(services[i]);
    
    console.log('updating vulcand backend in etcd '+host+' '+serviceEndpoint);

  }
  
}

function etcdCallback(err,resp, body) {
  if (err) throw err;
  console.log(body);
}

function getPodHostIP() {
  var authObj = {user:KUBE_API_USER,pass:KUBE_API_PASSWORD};
  
  // call kubernetes API
  request({uri:KUBE_API_PODS,auth:authObj}, function (error, response, body) {
    
    if (!error && response.statusCode == 200) {
      var pods = JSON.parse(body);
      
      // loop through pods and find pod that matches POD_NAME and get the host ip
      for (var i = 0; i < pods.items.length ; i++) {
        if(pods.items[i].metadata.name === POD_NAME) {
          // found the POD, save the IP address
          DOCKER_HOST_IP = pods.items[i].status.hostIP;
          DOCKER_POD_IP = pods.items[i].status.podIP;
          console.log('host IP is ' + DOCKER_HOST_IP + ' Pod IP is '+ DOCKER_POD_IP);
        }
      }
     
    } else {
        console.log('error calling kubernetes API '+error);
    }
  
  })
}


// If a consul API address is specified then publish service routes 
// so that they can be DNS resolved
function publishServiceToConsul(service){
  
  
  if(typeof(CONSUL_API_ADDRESS)!== 'undefined') {
   
    var hostname = service.name+'-'+service.namespace;
    var environment = ENVIRONMENT_NAME;
    var consulId = hostname + '-' + ENVIRONMENT_NAME;
    
    var consulSvc = {
                  id: consulId,
                  name: environment, 
                  tags: [hostname], 
                  port: VULCAND_HOST_PORT,
                  address:DOCKER_HOST_IP
                };
                
    var bodyStr=JSON.stringify(consulSvc);
    var requestOpts = {url:CONSUL_API_ADDRESS,body:bodyStr};
    
    if(typeof(CONSUL_API_TOKEN)!== 'undefined') {
      
      requestOpts.headers = { 'X-Consul-Token': CONSUL_API_TOKEN }
    } 
    
    // call kubernetes API
    request.put(requestOpts, function (error, response, body) {
      console.log("Publish service to consul"); 
      
      if (!error && response.statusCode == 200) {
        
        console.log('service '+hostname+'.'+environment+' registered in consul');
        
      } else {
          console.log('error adding service '+hostname+'.'+environment+' to consul: '+error);
      }
    
    })
  }
}

// on startup get the IP address of the HOST the pod is running on from the kubernetes API
getPodHostIP();

// Poll the kubernetes API for new services 
// TODO we should be able to make this event based.
Repeat(checkServices).every(SVC_POLL_INTERVAL, 'sec').start.in(2, 'sec');
