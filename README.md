# vulcan ingress controller

Kubernetes service router is an alternative to the following kubernetes loadbalancing/routing options

- nodePort: Specifying a service as type nodePort makes that service available on the same port of every kubernetes node.
- LoadBalancer: Allocates a cloud loadbalancer that balances traffic between pods of a service. e.g. an ELB in AWS 
- Ingress controller allows a service to be exposed via a specific url or context path.

Based on an idea from https://www.nginx.com/blog/load-balancing-kubernetes-services-nginx-plus/

This document explains how to create a loadbalancer that listens for new services being registered within a particular namespace and then creates a vulcand
backend entry corresponding to the service

### Optional - Choosing the Node That Hosts the router pod
(Running the router on a specific node is not required if you have a consul instance, see consul info later in this document)
To designate the node where the router pod runs, we add a label to that node. We get the list of all nodes by running:

```
kubectl get nodes
```

We can choose a node and then label it 

```
kubectl label node ranchercattle0 role=ingress
```

Define a replication controller for vulcand using etcd, the hostPort value is what will be exposed on the physical IP address of the chosen VM

```
apiVersion: v1
kind: ReplicationController
metadata:
  name: router
spec:
  replicas: 1
  selector:
    name: router
  template:
    metadata:
      labels:
        name: router
    spec:
      nodeSelector:
      - role: ingress
      containers:
      - name: vulcand
        image: mailgun/vulcand:v0.8.0-beta.2
        ports:
          - containerPort: 8182
          - containerPort: 8181
            hostPort: 80
        command: ["/go/bin/vulcand","-apiInterface=0.0.0.0","--etcd=http://localhost:4001"]
      - name: etcd
        image: elcolio/etcd:latest
        ports:
          - containerPort: 4001
      - name: vulcaningress
        image: zekizeki/vulcaningress:0.0.7
        env:
          - name: ETCD_HOST
            value: "localhost"
          - name: ETCD_PORT
            value: "4001"
          - name: KUBE_SELECTOR
            value: "type%3Dingress"
          - name: KUBE_API_URL
            value: "http://192.168.99.100:8080/r/projects/1a8/kubernetes/api"
          - name: KUBE_API_USER
            value: yourusername
          - name: KUBE_API_PASSWORD
            value: yourpassword
          - name: DOMAIN
            value: service.consul
          - name: ENVIRONMENT_NAME
            value: tooling
          - name: POD_NAME
            valueFrom:
              fieldRef:
                fieldPath: metadata.name
          - name: CONSUL_API_ADDRESS
            value: "http://127.0.0.1:8500/v1/agent/service/register"
```

# Create the router

```
kubectl create -f router.yaml
```

The router will now be available on port 8090 of the chosen kubernetes node. No backends are currently configured.


# Service labels

In order to route to a service the service must be assigned some labels that make it discoverable by the router pod.

The only required label is ...

```
role=ingress
```

# Service Annotations

optionally a path annotation may be used, this will route any inbound traffic to the router on certain context path to the service address ( the default path is / )

```
path=/contextpath
```

optionally a host annotation may be used, by default the host name is made up of the service name and the namespace the service is published into combined with a domain name set by the router administrator.

```
host=myservice.mydomain.com
```

Example replication controller and service ...

```
apiVersion: v1
kind: ReplicationController
metadata:
  name: webtest1
spec:
  replicas: 1
  selector:
    name: webtest1
  template:
    metadata:
      labels:
        name: webtest1
    spec:
      containers:
      - name: webtest1
        image: bungoume/debug-server:latest
        ports:
          - containerPort: 80
          
---            
            
apiVersion: v1
kind: Service
metadata:
  name: webtest1
  labels:
    name: webtest1
    type: ingress
  annotations:
    path: /mycontext
    host: myapp.mydomain.com
spec:
  ports:
  - port: 80
    targetPort: 80
  selector:
    name: webtest1
```

Create the rc and service

```
kubectl create -f webtest1.yaml
```

If published into the default namespace the above service would be routable using...  (this is assuming *.mydomain.com has been configured to resolve to the IP of the router machine)

http://webtest1-default.mydomain.com/


# Using Consul for service discovery
To publish service addresses to consul ensure that the following environment variables are set on the vulcaningress container

```
- name: POD_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
- name: DOMAIN
  value: service.consul
- name: ENVIRONMENT_NAME
  value: tooling
- name: CONSUL_API_ADDRESS
  value: http://consulhost:8500/v1/agent/service/register

```

The environment name will be combined with the kubernetes service name and namespace to make up a routable host name.

e.g.    myservice-mynamespace.myenv.service.consul

With the above configuration a service with the label role=ingress will be made DNS discoverable using this naming convention.
When a service is discovered a service entry is published to consul. Consul can act as a DNS server and make this service discoverable.


