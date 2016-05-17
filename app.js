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
var DOMAIN =  process.env.DOMAIN || '.kubernetes';

var etcd = new etcdnodejs({
    url: 'http://'+ETCD_HOST+':'+ETCD_PORT
})


// call the kubernetes API and get the list of services tagged
function checkServices() {
  console.log("requesting services from " + KUBE_API);
  
  // call kubernetes API
  request({uri:KUBE_API}, function (error, response, body) {
    
    if (!error && response.statusCode == 200) {
      var services = parseJSON(JSON.parse(body));
      
      console.log(services);
      
      // add service into etcd backend for vulcand
      addServiceBackends(services);
     
    } else {
        console.log('error calling kubernetes API '+error)
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
      labels: serviceList.items[i].metadata.labels
    }
    
    services.push(service);
  }
  
  return services;
  
}

// process discovered services and add frontends and backends for the them in etcd for vulcand to route with.
function addServiceBackends(services) {
  
  // loop through any services that had a type=ui label added in their metadata
  
  for(var i = 0; i < services.length;i++) {
    
    var host = services[i].name+"-"+services[i].namespace+DOMAIN;
    var serviceEndpoint = "http://"+services[i].ip + ":" + services[i].port
    var name = services[i].name+"-"+services[i].namespace;
    var path = '/';
    
    // allow a frontend to have a context path set for it
    if(typeof(services[i].labels.path) !== 'undefined') {
      
      // ideally / should be in the path value but labels don't allow / characters :(
      path = '/'+services[i].labels.path;
    
    } 
    
    // allow the service to overide the host value through a label
    if(typeof(services[i].labels.host) !== 'undefined') {
      host = services[i].labels.host;
    } 
    
    // add backend and frontend info for vulcand to read from etcd
    etcd.write({key: "/vulcand/backends/"+name+"/backend",value: '{"Type": "http"}',ttl:30}, etcdCallback);
    etcd.write({key: "/vulcand/backends/"+name+"/servers/srv1",value: '{"URL": "'+serviceEndpoint+'"}',ttl:30}, etcdCallback);
    
    var etcdvalue = {
       Type: 'http',
       BackendId: name,
       Route: 'Path("'+path+'") && Host("'+host+'")'
    }
    
    etcd.write({key: '/vulcand/frontends/'+name+'/frontend',value:JSON.stringify(etcdvalue),ttl:30}, etcdCallback);
    
    console.log('updating vulcand backend in etcd '+host+' '+serviceEndpoint);

  }
  
}

function etcdCallback(err,resp, body) {
  if (err) throw err;
  console.log(body);
}

// Poll the kubernetes API for new services 
// TODO we should be able to make this event based.
Repeat(checkServices).every(SVC_POLL_INTERVAL, 'sec').start.in(2, 'sec');
