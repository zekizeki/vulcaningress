# vulcan ingress controller

Kubernetes service router is an alternative to the following kubernetes loadbalancing/routing options

- nodePort: Specifying a service as type nodePort makes that service available on the same port of every kubernetes node.
- LoadBalancer: Allocates a cloud loadbalancer that balances traffic between pods of a service. e.g. an ELB in AWS 
- Ingress controller allows a service to be exposed via a specific url or context path.

Based on an idea from https://www.nginx.com/blog/load-balancing-kubernetes-services-nginx-plus/

This document explains how to create a loadbalancer that listens for new services being registered within a particular namespace and then creates a vulcand
backend entry corresponding to the service

###Choosing the Node That Hosts the router pod
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
            hostPort: 8090
        command: ["/go/bin/vulcand","-apiInterface=0.0.0.0","--etcd=http://localhost:4001"]
      - name: etcd
        image: elcolio/etcd:latest
        ports:
          - containerPort: 4001
      - name: vulcaningress
        image: zekizeki/vulcaningress:0.0.4
        env:
          - name: ETCD_HOST
            value: "localhost"
          - name: ETCD_PORT
            value: "4001"
          - name: KUBE_SELECTOR
            value: "type%3Dingress"
          - name: KUBE_API_URL
            value: "http://9.45.207.152:8080/r/projects/1a8/kubernetes/api"
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

optionally a path label may be used, this will route any inbound traffic to the router on certain context path to the service address ( the default path is / )

```
path=contextpath
```

optionally a host label may be used, by default the host name is made up of the service name and the namespace the service is published into combined with a domain name set by the router administrator.

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




